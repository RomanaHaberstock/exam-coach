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
// Whatever the provider, the page always receives the same stream format
// (server-sent events with "content_block_delta" and "message_delta" events).

const SYSTEM = "You are the AI inside Exam Coach, a study planning app for university students. When asked for JSON, reply with only valid JSON and no other text.";

const DEFAULT_MODELS = {
  gemini: { default: "gemini-3.8-flash", quick: "gemini-3.5-flash-lite" },
  anthropic: { default: "claude-sonnet-5-5", quick: "claude-haiku-5-5" },
};

function env(name) {
  if (globalThis.Netlify && Netlify.env && Netlify.env.get) return Netlify.env.get(name);
  if (typeof Deno !== "undefined") return Deno.env.get(name);
  return globalThis.process ? process.env[name] : undefined;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const sseHeaders = { "content-type": "text/event-stream", "cache-control": "no-store" };

export function provider() {
  const p = String(env("AI_PROVIDER") || "").trim().toLowerCase();
  if (p === "gemini" || p === "anthropic") return p;
  if (env("GEMINI_API_KEY")) return "gemini";
  if (env("ANTHROPIC_API_KEY")) return "anthropic";
  return "gemini";
}

export async function handle(request) {
  const prov = provider();
  const key = env(prov === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY");
  const code = env("ACCESS_CODE") || "";
  const codeOk = !code || request.headers.get("x-access-code") === code;

  if (request.method === "GET") return json({ ok: !!key, provider: prov, needsCode: !!code, codeOk });
  if (request.method !== "POST") return json({ error: "bad_request" }, 405);
  if (!key) return json({ error: "not_configured" }, 503);
  if (!codeOk) return json({ error: "access_code" }, 401);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt) return json({ error: "bad_request" }, 400);
  if (prompt.length > 600000) return json({ error: "prompt_too_large" }, 413);

  const tier = body.tier === "quick" ? "quick" : "default";
  const prefix = prov === "gemini" ? "GEMINI" : "ANTHROPIC";
  const model = env(tier === "quick" ? `${prefix}_MODEL_QUICK` : `${prefix}_MODEL`) || DEFAULT_MODELS[prov][tier];

  try {
    return prov === "gemini" ? await callGemini(key, model, prompt) : await callAnthropic(key, model, prompt);
  } catch (e) {
    return json({ error: "upstream_error" }, 502);
  }
}

// ---- Anthropic: its stream already has the format the page reads -------------------
async function callAnthropic(key, model, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 16000, stream: true, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) {
    const s = res.status;
    const error = s === 401 || s === 403 ? "bad_key" : s === 429 || s === 529 ? "rate_limited" : s === 413 ? "prompt_too_large" : s === 404 ? "model_unavailable" : "upstream_error";
    return json({ error, status: s }, s === 429 ? 429 : 502);
  }
  return new Response(res.body, { headers: sseHeaders });
}

// ---- Gemini: convert its stream into the same format ---------------------------------
async function callGemini(key, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 32768, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) {
    const s = res.status;
    let msg = ""; try { msg = JSON.stringify(await res.json()); } catch (e) {}
    const error = s === 429 ? "rate_limited"
      : s === 403 || (s === 400 && /API[_ ]?KEY/i.test(msg)) ? "bad_key"
      : s === 404 ? "model_unavailable"
      : s === 400 && /token|too long|exceeds/i.test(msg) ? "prompt_too_large"
      : "upstream_error";
    return json({ error, status: s }, s === 429 ? 429 : 502);
  }
  return new Response(geminiToEvents(res.body), { headers: sseHeaders });
}

const FINISH = { STOP: "end_turn", MAX_TOKENS: "max_tokens", SAFETY: "refusal", RECITATION: "refusal", PROHIBITED_CONTENT: "refusal", BLOCKLIST: "refusal", SPII: "refusal" };

export function geminiToEvents(stream) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buf = "", stop = null;
  const send = (ctrl, obj) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
  const handleEvent = (ctrl, raw) => {
    const line = raw.split("\n").find(l => l.startsWith("data:"));
    if (!line) return;
    let d; try { d = JSON.parse(line.slice(5)); } catch (e) { return; }
    if (d.error) { send(ctrl, { type: "error", error: { type: d.error.code === 429 ? "overloaded_error" : "api_error" } }); return; }
    if (d.promptFeedback && d.promptFeedback.blockReason) stop = "refusal";
    const c = d.candidates && d.candidates[0];
    if (!c) return;
    for (const p of (c.content && c.content.parts) || []) {
      if (typeof p.text === "string" && p.text && !p.thought) send(ctrl, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p.text } });
    }
    if (c.finishReason) stop = FINISH[c.finishReason] || "end_turn";
  };
  return stream.pipeThrough(new TransformStream({
    transform(chunk, ctrl) {
      buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) { handleEvent(ctrl, buf.slice(0, i)); buf = buf.slice(i + 2); }
    },
    flush(ctrl) {
      buf += dec.decode();
      if (buf.trim()) handleEvent(ctrl, buf.replace(/\r\n/g, "\n"));
      send(ctrl, { type: "message_delta", delta: { stop_reason: stop || "end_turn" } });
    },
  }));
}

export default handle;
export const config = { path: "/api/ai" };
