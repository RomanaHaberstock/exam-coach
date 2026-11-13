// Exam Coach AI backend (Netlify Edge Function, served at /api/ai).
//
// The page sends a prompt here; this function forwards it to the AI provider and streams
// the answer back. API keys stay on the server and are never sent to the browser.
//
// Providers:
//   gemini     Google Gemini API (has a free tier). Needs GEMINI_API_KEY.
//   anthropic  Anthropic API (paid). Needs ANTHROPIC_API_KEY.
// Choose with AI_PROVIDER. If it isn't set, Gemini is used when GEMINI_API_KEY exists,
// otherwise Anthropic when ANTHROPIC_API_KEY exists.
//
// The page always receives the same stream format (server-sent events):
//   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
//   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}
//   data: {"type":"error","error":{"type":"<code>","message":"<status>: <details>"}}
// The stream starts right away and sends a keep-alive comment every few seconds, so
// long requests (big scripts) aren't cut off by Netlify's limit on how long a function
// may take before it starts answering.

const SYSTEM = "You are the AI inside Exam Coach, a study planning app for university students. When asked for JSON, reply with only valid JSON and no other text.";

const DEFAULT_MODELS = {
  gemini: { default: "gemini-3.8-flash", quick: "gemini-3.5-flash-lite" },
  anthropic: { default: "claude-sonnet-5-5", quick: "claude-haiku-5-5" },
};
// Keep-alive comment interval (changeable by the tests).
export const STREAM = { keepAliveMs: 5000 };
// Temporary provider errors (500/502/503/529, e.g. the free tier is overloaded) are retried
// up to 3 times after these waits (plus up to `jitterMs`), then the quick model is tried once
// if it differs. Worst case about 18 s of waiting; keep-alive comments keep the stream open.
// A 429 (quota or rate limit) is not retried with the same model, because those limits last a
// minute or a day; the quick model has its own quota on the free tier, so it gets one try.
// `sleep` can be replaced by the tests.
export const RETRY = { delaysMs: [2000, 5000, 10000], jitterMs: 500, sleep: ms => new Promise(r => setTimeout(r, ms)) };
const TEMPORARY = new Set([500, 502, 503, 529]);
// Request size: the page's largest request is a material-analysis part of about 90,000 characters
// (ANALYZE_CHARS = 80,000 plus instructions and topic names); quizzes send at most ~50,000.
// The limits leave room for that, also when every character needs several bytes as JSON/UTF-8.
const MAX_PROMPT_CHARS = 200000;
const MAX_BODY_BYTES = 1500000;
// Best-effort limits per client IP. Edge functions run in many short-lived isolates, so these
// counters are per isolate: they stop quick bursts, not a determined attacker (that needs
// ACCESS_CODE or a limit in front of the site).
// A whole class can share one IP (university Wi-Fi), so both limits are generous.
export const RATE = { windowMs: 60000, max: 120 };        // AI requests per minute (POST only)
export const CODE_RATE = { windowMs: 600000, max: 30 };   // wrong access codes per 10 minutes

function env(name) {
  if (globalThis.Netlify && Netlify.env && Netlify.env.get) return Netlify.env.get(name);
  if (typeof Deno !== "undefined") return Deno.env.get(name);
  return globalThis.process ? process.env[name] : undefined;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const sseHeaders = { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" };
const event = obj => `data: ${JSON.stringify(obj)}\n\n`;
// `fallback`: the quick model was tried too and didn't help (the page says so).
const errorEvent = (code, message = "", fallback = false) => event({ type: "error", error: { type: code, message: String(message).slice(0, 300), ...(fallback ? { fallback: true } : {}) } });

// CPU budget: Netlify stops an edge function that uses more than 50 ms of CPU time per request
// (waiting for the AI doesn't count), and the page then only sees the connection break off.
// So the body is read and parsed once, the request to the provider is built once per model
// (retries reuse it), and the stream conversion does constant work per piece of text
// (no re-scanning of a growing buffer). Measured locally for the largest allowed request
// (~280 kB body) plus a 120,000-character answer: about 3-12 ms CPU per request.
// An unhandled promise rejection would end the whole isolate, and with it every answer it
// is streaming at that moment; log it instead.
if (typeof globalThis.addEventListener === "function" && typeof Deno !== "undefined") {
  globalThis.addEventListener("unhandledrejection", ev => { ev.preventDefault(); console.log("Exam Coach AI error: unhandled", ev.reason && ev.reason.message ? ev.reason.message : ev.reason); });
}

export function provider() {
  const p = String(env("AI_PROVIDER") || "").trim().toLowerCase();
  if (p === "gemini" || p === "anthropic") return p;
  if (env("GEMINI_API_KEY")) return "gemini";
  if (env("ANTHROPIC_API_KEY")) return "anthropic";
  return "gemini";
}

export async function handle(request, context) {
  const prov = provider();
  const key = env(prov === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY");
  const code = env("ACCESS_CODE") || "";
  const ip = clientIp(request, context);

  if (!originOk(request)) return json({ error: "forbidden" }, 403);
  const given = request.headers.get("x-access-code") || "";
  // Too many wrong codes from this IP: no more code checks (a status check without a code still works).
  if (ip && (given || request.method !== "GET") && limited(codeFails, ip, CODE_RATE, false)) return json({ error: "rate_limited" }, 429);
  const codeOk = !code || await sameSecret(given, code);
  if (!codeOk && given && ip) limited(codeFails, ip, CODE_RATE, true);

  if (request.method === "GET") return json({ ok: !!key, provider: prov, needsCode: !!code, codeOk });
  if (request.method !== "POST") return json({ error: "bad_request" }, 405);
  if (!key) return json({ error: "not_configured" }, 503);
  if (!codeOk) return json({ error: "access_code" }, 401);
  if (ip && limited(requests, ip, RATE, true)) return json({ error: "rate_limited" }, 429);

  // Size check before reading the body: by the declared length, then while reading
  // (a chunked request has no declared length).
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) return json({ error: "prompt_too_large" }, 413);
  let body;
  try {
    const raw = await readLimited(request, MAX_BODY_BYTES);
    if (raw == null) return json({ error: "prompt_too_large" }, 413);
    body = JSON.parse(raw);
  } catch (e) { return json({ error: "bad_request" }, 400); }
  const prompt = body && typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt) return json({ error: "bad_request" }, 400);
  if (prompt.length > MAX_PROMPT_CHARS) return json({ error: "prompt_too_large" }, 413);

  const tier = body.tier === "quick" ? "quick" : "default";
  const prefix = prov === "gemini" ? "GEMINI" : "ANTHROPIC";
  const modelFor = t => env(t === "quick" ? `${prefix}_MODEL_QUICK` : `${prefix}_MODEL`) || DEFAULT_MODELS[prov][t];
  // The model asked for, then the quick model as a fallback when the first stays busy.
  const models = [...new Set([modelFor(tier), modelFor("quick")])];

  return streamResponse((send, signal) => prov === "gemini" ? runGemini(send, key, models, prompt, signal) : runAnthropic(send, key, models, prompt, signal));
}

// ---- request checks ---------------------------------------------------------------
// Netlify passes the client IP in the context (and a header); local tests have neither.
function clientIp(request, context) {
  return (context && context.ip) || request.headers.get("x-nf-client-connection-ip") || "";
}

// Browsers send Origin on cross-site requests. Only the site itself (same host as the request)
// and origins listed in ALLOWED_ORIGINS (comma-separated) may call the AI. Requests without
// Origin (same-origin GET, tools, tests) pass; ACCESS_CODE is what protects against those.
function originOk(request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return !origin;
  let host;
  try { host = new URL(origin).host; } catch (e) { return false; }
  const own = request.headers.get("host") || new URL(request.url).host;
  if (host === own || host === new URL(request.url).host) return true;
  const extra = String(env("ALLOWED_ORIGINS") || "").split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
  return extra.includes(origin);
}

// Compares the access code without leaking through timing how much of it was right:
// both sides are hashed to the same length, then every byte is compared.
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", enc.encode(String(s)))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

// Fixed-window counters per IP. `count` adds this request; otherwise it only checks.
const requests = new Map(), codeFails = new Map();
function limited(map, ip, { windowMs, max }, count) {
  const now = Date.now();
  if (map.size > 5000) for (const [k, v] of map) if (v.reset <= now) map.delete(k);
  let r = map.get(ip);
  if (!r || r.reset <= now) { r = { n: 0, reset: now + windowMs }; map.set(ip, r); }
  if (count) r.n++;
  return count ? r.n > max : r.n >= max;
}
export function resetLimits() { requests.clear(); codeFails.clear(); }

// Reads the body as text, or returns null as soon as it is larger than `max` bytes.
// The bytes are collected and decoded once at the end.
async function readLimited(request, max) {
  if (!request.body) return "";
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch (e) {} return null; }
    chunks.push(value);
  }
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

// Error details for the page name the HTTP status, not the provider; the log keeps the provider.
const STATUS_TEXT = { 400: "bad request", 401: "unauthorized", 403: "forbidden", 404: "not found", 408: "timeout", 413: "too large", 429: "rate limit", 500: "server error", 502: "bad gateway", 503: "unavailable", 504: "timeout", 529: "overloaded" };
const statusLabel = status => `${status} ${STATUS_TEXT[status] || "error"}`;

// Starts the response immediately, keeps it alive while waiting, and turns any
// failure into an error event the page can show. When the page goes away (tab closed,
// connection lost), the request to the provider is aborted, so no more CPU time is spent
// reading an answer nobody receives.
function streamResponse(run) {
  const enc = new TextEncoder(), gone = new AbortController();
  let open = true;
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = s => { if (open) { try { ctrl.enqueue(enc.encode(s)); } catch (e) { open = false; gone.abort(); } } };
      send(": connected\n\n");
      const ping = setInterval(() => send(": keep-alive\n\n"), STREAM.keepAliveMs);
      try { await run(send, gone.signal); }
      catch (e) {
        const msg = e && e.message ? e.message : "The request to the AI failed.";
        if (gone.signal.aborted) console.log("Exam Coach AI: the page closed the connection");
        else if (e && e.broken) { console.log("Exam Coach AI error: the provider's answer broke off:", msg); send(errorEvent("stream_broken", `The AI's answer broke off: ${msg}`)); }
        else { console.log("Exam Coach AI error:", msg); send(errorEvent("upstream_error", msg)); }
      } finally {
        clearInterval(ping);
        open = false;
        try { ctrl.close(); } catch (e) {}
      }
    },
    cancel() { open = false; gone.abort(); },
  });
  return new Response(stream, { headers: sseHeaders });
}

// Calls the provider with `request(model)`. On a temporary server error it waits and tries
// again (RETRY.delaysMs). If the model still fails that way, or it answers 429 (quota or rate
// limit), the quick model (when it is a different one) gets one try; if that fails too, the
// first model's error is reported, with `fallbackTried` set.
// cancel() returns a promise; a rejection must not go unhandled (that would end the isolate).
const drop = res => { try { const p = res.body && res.body.cancel(); if (p && p.catch) p.catch(() => {}); } catch (e) {} };
async function fetchWithRetry(name, models, request) {
  const [model, fallback] = models;
  let res = await request(model);
  for (let i = 0; i < RETRY.delaysMs.length && TEMPORARY.has(res.status); i++) {
    const wait = RETRY.delaysMs[i] + Math.round(Math.random() * RETRY.jitterMs);
    console.log(`Exam Coach AI retry: ${name} ${model} answered ${res.status}; try ${i + 2} of ${RETRY.delaysMs.length + 1} in ${wait} ms`);
    drop(res);
    await RETRY.sleep(wait);
    res = await request(model);
  }
  const quota = res.status === 429;
  if (!(TEMPORARY.has(res.status) || quota) || !fallback) return { res, fallbackTried: false };
  console.log(quota ? `Exam Coach AI retry: ${name} ${model} answered 429 (quota or rate limit); trying ${fallback} instead`
    : `Exam Coach AI retry: ${name} ${model} still answers ${res.status}; trying ${fallback} instead`);
  const alt = await request(fallback);
  if (alt.ok) { drop(res); return { res: alt, fallbackTried: true }; }
  console.log(`Exam Coach AI retry: ${name} ${fallback} answered ${alt.status} too`);
  drop(alt);
  return { res, fallbackTried: true };
}

async function readError(res) {
  try {
    const t = await res.text();
    try { const j = JSON.parse(t); return (j.error && (j.error.message || j.error.status)) || t; } catch (e) { return t; }
  } catch (e) { return ""; }
}

function errorCode(status, message) {
  if (status === 429) return "rate_limited";
  if (status === 503 || status === 529) return "busy";
  if (status === 401 || status === 403 || (status === 400 && /API[_ ]?KEY/i.test(message))) return "bad_key";
  if (status === 404) return "model_unavailable";
  if (status === 413 || (status === 400 && /token|too long|too large|exceeds/i.test(message))) return "prompt_too_large";
  return "upstream_error";
}

// Passes the provider's answer on as text. If reading it fails half-way (the provider's
// connection broke off), the error is marked so the page gets the code "stream_broken".
async function pipe(res, onText, signal) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  const stop = () => { try { reader.cancel().catch(() => {}); } catch (e) {} };
  if (signal) { if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true }); }
  for (;;) {
    let r;
    try { r = await reader.read(); }
    catch (e) { if (!(signal && signal.aborted)) e.broken = true; throw e; }
    if (r.done) break;
    onText(dec.decode(r.value, { stream: true }));
  }
  onText(dec.decode());
}

async function sendError(send, name, res, fallbackTried) {
  const msg = await readError(res);
  console.log(`Exam Coach AI error: ${name} ${res.status} ${msg}${fallbackTried ? " (the quick model was tried too)" : ""}`);
  send(errorEvent(errorCode(res.status, msg), `${statusLabel(res.status)}: ${msg}`, fallbackTried));
}

// ---- Anthropic: its stream already has the format the page reads -------------------
async function runAnthropic(send, key, models, prompt, signal) {
  // The request body names the model, so it is built once per model (not once per retry).
  const bodies = new Map();
  const bodyFor = model => bodies.get(model) || bodies.set(model, JSON.stringify({ model, max_tokens: 16000, stream: true, system: SYSTEM, messages: [{ role: "user", content: prompt }] })).get(model);
  const { res, fallbackTried } = await fetchWithRetry("Anthropic", models, model => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: bodyFor(model), signal,
  }));
  if (!res.ok) return sendError(send, "Anthropic", res, fallbackTried);
  await pipe(res, send, signal);
}

// ---- Gemini: convert its stream into the same format ---------------------------------
async function runGemini(send, key, models, prompt, signal) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 32768, responseMimeType: "application/json" },
  });
  const { res, fallbackTried } = await fetchWithRetry("Gemini", models, model => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body, signal,
  }));
  if (!res.ok) return sendError(send, "Gemini", res, fallbackTried);
  const parser = geminiParser(send);
  await pipe(res, parser.push, signal);
  parser.end();
}

const FINISH = { STOP: "end_turn", MAX_TOKENS: "max_tokens", SAFETY: "refusal", RECITATION: "refusal", PROHIBITED_CONTENT: "refusal", BLOCKLIST: "refusal", SPII: "refusal" };

// Reads Gemini's server-sent events (in any chunk sizes) and sends page events.
// Linear in the size of the stream: each new piece of text is searched once for the end of an
// event ("\n\n"); pieces of an unfinished event are collected and joined once it is complete.
// (Appending to one buffer and searching/slicing it again for every piece costs time
// proportional to the square of an event's size: ~30-60 ms CPU for one 200 kB event that
// arrives in 256-byte pieces, more than Netlify allows.)
export function geminiParser(send) {
  let pending = [], cr = false, stop = null;
  const handleEvent = raw => {
    const line = raw.split("\n").find(l => l.startsWith("data:"));
    if (!line) return;
    let d; try { d = JSON.parse(line.slice(5)); } catch (e) { return; }
    if (d.error) {
      console.log("Exam Coach AI error: Gemini stream", d.error.code, d.error.message || d.error.status || "");
      send(errorEvent(errorCode(d.error.code, d.error.message || ""), `${d.error.code ? statusLabel(d.error.code) + ": " : ""}${d.error.message || d.error.status || "error"}`)); return;
    }
    if (d.promptFeedback && d.promptFeedback.blockReason) stop = "refusal";
    const c = d.candidates && d.candidates[0];
    if (!c) return;
    for (const p of (c.content && c.content.parts) || []) {
      if (typeof p.text === "string" && p.text && !p.thought) send(event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p.text } }));
    }
    if (c.finishReason) stop = FINISH[c.finishReason] || "end_turn";
  };
  return {
    push(text) {
      // "\r\n" line ends may be split between pieces: a trailing "\r" waits for the next piece.
      if (cr) { text = "\r" + text; cr = false; }
      if (text.endsWith("\r")) { cr = true; text = text.slice(0, -1); }
      if (text.includes("\r")) text = text.replace(/\r\n/g, "\n");
      if (!text) return;
      let from = 0, i;
      // an event end split between pieces: the last piece ended with "\n", this one starts with it
      if (text[0] === "\n" && pending.length && pending[pending.length - 1].endsWith("\n")) {
        handleEvent(pending.join("")); pending = []; from = 1;
      }
      while ((i = text.indexOf("\n\n", from)) >= 0) {
        pending.push(text.slice(from, i));
        handleEvent(pending.join("")); pending = [];
        from = i + 2;
      }
      if (from < text.length) pending.push(from ? text.slice(from) : text);
    },
    end() {
      const rest = pending.join("") + (cr ? "\r" : "");
      if (rest.trim()) handleEvent(rest);
      pending = []; cr = false;
      send(event({ type: "message_delta", delta: { stop_reason: stop || "end_turn" } }));
    },
  };
}

// Same conversion as a stream transform (used by the tests).
export function geminiToEvents(stream) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  let parser;
  return stream.pipeThrough(new TransformStream({
    start(ctrl) { parser = geminiParser(s => ctrl.enqueue(enc.encode(s))); },
    transform(chunk) { parser.push(dec.decode(chunk, { stream: true })); },
    flush() { parser.push(dec.decode()); parser.end(); },
  }));
}

export default handle;
export const config = { path: "/api/ai" };
