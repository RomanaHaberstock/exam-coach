// Exam Coach AI backend (Netlify Edge Function, served at /api/ai).
// Forwards prompts from the page to the Anthropic API and streams the answer back.
// The API key stays here on the server and is never sent to the browser.

const SYSTEM = "You are the AI inside Exam Coach, a study planning app for university students. When asked for JSON, reply with only valid JSON and no other text.";

function env(name) {
  if (globalThis.Netlify && Netlify.env && Netlify.env.get) return Netlify.env.get(name);
  if (typeof Deno !== "undefined") return Deno.env.get(name);
  return globalThis.process ? process.env[name] : undefined;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handle(request) {
  const key = env("ANTHROPIC_API_KEY");
  const code = env("ACCESS_CODE") || "";
  const codeOk = !code || request.headers.get("x-access-code") === code;

  if (request.method === "GET") return json({ ok: !!key, needsCode: !!code, codeOk });
  if (request.method !== "POST") return json({ error: "bad_request" }, 405);
  if (!key) return json({ error: "not_configured" }, 503);
  if (!codeOk) return json({ error: "access_code" }, 401);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt) return json({ error: "bad_request" }, 400);
  if (prompt.length > 600000) return json({ error: "prompt_too_large" }, 413);

  const model = body.tier === "quick"
    ? (env("ANTHROPIC_MODEL_QUICK") || "claude-haiku-5-5")
    : (env("ANTHROPIC_MODEL") || "claude-sonnet-5-5");

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 16000, stream: true, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
  });
  if (!upstream.ok) {
    const s = upstream.status;
    const error = s === 401 || s === 403 ? "bad_key" : s === 429 || s === 529 ? "rate_limited" : s === 413 ? "prompt_too_large" : "upstream_error";
    return json({ error, status: s }, s === 429 ? 429 : 502);
  }
  return new Response(upstream.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

export default handle;
export const config = { path: "/api/ai" };
