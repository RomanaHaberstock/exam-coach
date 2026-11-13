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
const KEEPALIVE_MS = 5000;
const RETRY_DELAY_MS = 2000;
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const event = obj => `data: ${JSON.stringify(obj)}\n\n`;
const errorEvent = (code, message = "") => event({ type: "error", error: { type: code, message: String(message).slice(0, 300) } });

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
  const model = env(tier === "quick" ? `${prefix}_MODEL_QUICK` : `${prefix}_MODEL`) || DEFAULT_MODELS[prov][tier];

  return streamResponse(send => prov === "gemini" ? runGemini(send, key, model, prompt) : runAnthropic(send, key, model, prompt));
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
async function readLimited(request, max) {
  if (!request.body) return "";
  const reader = request.body.getReader(), dec = new TextDecoder();
  let size = 0, out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch (e) {} return null; }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

// Error details for the page name the HTTP status, not the provider; the log keeps the provider.
const STATUS_TEXT = { 400: "bad request", 401: "unauthorized", 403: "forbidden", 404: "not found", 408: "timeout", 413: "too large", 429: "rate limit", 500: "server error", 502: "bad gateway", 503: "unavailable", 504: "timeout", 529: "overloaded" };
const statusLabel = status => `${status} ${STATUS_TEXT[status] || "error"}`;

// Starts the response immediately, keeps it alive while waiting, and turns any
// failure into an error event the page can show.
function streamResponse(run) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      let open = true;
      const send = s => { if (open) { try { ctrl.enqueue(enc.encode(s)); } catch (e) { open = false; } } };
      send(": connected\n\n");
      const ping = setInterval(() => send(": keep-alive\n\n"), KEEPALIVE_MS);
      try { await run(send); }
      catch (e) {
        console.log("Exam Coach AI error:", e && e.message ? e.message : e);
        send(errorEvent("upstream_error", e && e.message ? e.message : "The request to the AI failed."));
      } finally {
        clearInterval(ping);
        open = false;
        try { ctrl.close(); } catch (e) {}
      }
    },
  });
  return new Response(stream, { headers: sseHeaders });
}

// Calls the provider once more if it answers with a temporary server error.
async function fetchWithRetry(url, init) {
  let res = await fetch(url, init);
  if (res.status === 500 || res.status === 502 || res.status === 503 || res.status === 529) {
    await sleep(RETRY_DELAY_MS);
    res = await fetch(url, init);
  }
  return res;
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

async function pipe(res, onText) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onText(dec.decode(value, { stream: true }));
  }
  onText(dec.decode());
}

// ---- Anthropic: its stream already has the format the page reads -------------------
async function runAnthropic(send, key, model, prompt) {
  const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 16000, stream: true, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) {
    const msg = await readError(res);
    console.log(`Exam Coach AI error: Anthropic ${res.status} ${msg}`);
    send(errorEvent(errorCode(res.status, msg), `${statusLabel(res.status)}: ${msg}`));
    return;
  }
  await pipe(res, send);
}

// ---- Gemini: convert its stream into the same format ---------------------------------
async function runGemini(send, key, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 32768, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) {
    const msg = await readError(res);
    console.log(`Exam Coach AI error: Gemini ${res.status} ${msg}`);
    send(errorEvent(errorCode(res.status, msg), `${statusLabel(res.status)}: ${msg}`));
    return;
  }
  const parser = geminiParser(send);
  await pipe(res, parser.push);
  parser.end();
}

const FINISH = { STOP: "end_turn", MAX_TOKENS: "max_tokens", SAFETY: "refusal", RECITATION: "refusal", PROHIBITED_CONTENT: "refusal", BLOCKLIST: "refusal", SPII: "refusal" };

// Reads Gemini's server-sent events (in any chunk sizes) and sends page events.
export function geminiParser(send) {
  let buf = "", stop = null;
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
      buf = (buf + text).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) { handleEvent(buf.slice(0, i)); buf = buf.slice(i + 2); }
    },
    end() {
      if (buf.trim()) handleEvent(buf);
      buf = "";
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
