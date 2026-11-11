// Unit tests for the AI backend (netlify/edge-functions/ai.js) with both providers.
// The provider APIs are replaced by fakes, so no keys or network are needed.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { handle, provider, geminiToEvents } from "../netlify/edge-functions/ai.js";

const realFetch = globalThis.fetch;
let next = null, lastCall = null;
globalThis.fetch = async (url, init) => { lastCall = { url: String(url), init }; return next(); };
after(() => { globalThis.fetch = realFetch; });

const VARS = ["AI_PROVIDER", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "ACCESS_CODE", "GEMINI_MODEL", "GEMINI_MODEL_QUICK", "ANTHROPIC_MODEL"];
beforeEach(() => { for (const v of VARS) delete process.env[v]; next = null; lastCall = null; });

const post = (body, headers = {}) => handle(new Request("http://x/api/ai", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const get = (headers = {}) => handle(new Request("http://x/api/ai", { headers }));
const streamOf = (...chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });
async function readEvents(res) {
  const text = await res.text();
  return text.split("\n\n").filter(Boolean).map(e => JSON.parse(e.replace(/^data: /, "")));
}

test("picks the provider from the keys or AI_PROVIDER", () => {
  assert.equal(provider(), "gemini");
  process.env.ANTHROPIC_API_KEY = "a";
  assert.equal(provider(), "anthropic");
  process.env.GEMINI_API_KEY = "g";
  assert.equal(provider(), "gemini");
  process.env.AI_PROVIDER = "Anthropic";
  assert.equal(provider(), "anthropic");
});

test("reports status, provider and access code on GET", async () => {
  assert.deepEqual(await (await get()).json(), { ok: false, provider: "gemini", needsCode: false, codeOk: true });
  process.env.GEMINI_API_KEY = "g"; process.env.ACCESS_CODE = "c";
  assert.deepEqual(await (await get()).json(), { ok: true, provider: "gemini", needsCode: true, codeOk: false });
  assert.equal((await (await get({ "x-access-code": "c" })).json()).codeOk, true);
});

test("refuses requests without a key or with a wrong access code", async () => {
  assert.equal((await (await post({ prompt: "hi" })).json()).error, "not_configured");
  process.env.GEMINI_API_KEY = "g"; process.env.ACCESS_CODE = "c";
  const r = await post({ prompt: "hi" }, { "x-access-code": "wrong" });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "access_code");
});

test("Gemini: sends the prompt and converts the stream", async () => {
  process.env.GEMINI_API_KEY = "g";
  next = () => new Response(streamOf(
    'data: {"candidates":[{"content":{"parts":[{"text":"thinking","thought":true},{"text":"{\\"a\\":"}]}}]}\r\n\r\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"1}"}]},"finish',
    'Reason":"STOP"}]}\r\n\r\n'));
  const res = await post({ prompt: "Return JSON", tier: "quick" });
  assert.match(lastCall.url, /models\/gemini-3\.5-flash-lite:streamGenerateContent\?alt=sse$/);
  assert.equal(lastCall.init.headers["x-goog-api-key"], "g");
  const sent = JSON.parse(lastCall.init.body);
  assert.equal(sent.contents[0].parts[0].text, "Return JSON");
  assert.equal(sent.generationConfig.responseMimeType, "application/json");
  const events = await readEvents(res);
  const text = events.filter(e => e.type === "content_block_delta").map(e => e.delta.text).join("");
  assert.equal(text, '{"a":1}', "thought parts are left out and split events are joined");
  assert.deepEqual(events.at(-1), { type: "message_delta", delta: { stop_reason: "end_turn" } });
});

test("Gemini: maps finish reasons and errors", async () => {
  process.env.GEMINI_API_KEY = "g";
  next = () => new Response(streamOf('data: {"candidates":[{"finishReason":"SAFETY"}]}\n\n'));
  assert.equal((await readEvents(await post({ prompt: "x" }))).at(-1).delta.stop_reason, "refusal");
  next = () => new Response(streamOf('data: {"candidates":[{"content":{"parts":[{"text":"{"}]},"finishReason":"MAX_TOKENS"}]}\n\n'));
  assert.equal((await readEvents(await post({ prompt: "x" }))).at(-1).delta.stop_reason, "max_tokens");
  const cases = [
    [429, { error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, "rate_limited", 429],
    [400, { error: { code: 400, message: "API key not valid. Please pass a valid API key." } }, "bad_key", 502],
    [403, { error: { code: 403, status: "PERMISSION_DENIED" } }, "bad_key", 502],
    [404, { error: { code: 404, message: "models/x is not found" } }, "model_unavailable", 502],
    [500, { error: { code: 500 } }, "upstream_error", 502],
  ];
  for (const [status, body, error, out] of cases) {
    next = () => new Response(JSON.stringify(body), { status });
    const r = await post({ prompt: "x" });
    assert.equal(r.status, out);
    assert.equal((await r.json()).error, error);
  }
});

test("Gemini: model can be changed with GEMINI_MODEL", async () => {
  process.env.GEMINI_API_KEY = "g"; process.env.GEMINI_MODEL = "gemini-3.6-flash";
  next = () => new Response(streamOf(""));
  await post({ prompt: "x" });
  assert.match(lastCall.url, /models\/gemini-3\.6-flash:/);
});

test("Anthropic: passes its stream through unchanged", async () => {
  process.env.ANTHROPIC_API_KEY = "a";
  const sse = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{}"}}\n\n';
  next = () => new Response(streamOf(sse));
  const res = await post({ prompt: "x" });
  assert.equal(lastCall.url, "https://api.anthropic.com/v1/messages");
  assert.equal(lastCall.init.headers["x-api-key"], "a");
  assert.equal(JSON.parse(lastCall.init.body).model, "claude-sonnet-5-5");
  assert.equal(await res.text(), sse);
  next = () => new Response("{}", { status: 401 });
  assert.equal((await (await post({ prompt: "x" })).json()).error, "bad_key");
});

test("handles the stream helper directly", async () => {
  const out = await new Response(geminiToEvents(streamOf('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}'))).text();
  assert.match(out, /"text":"ok"/);
  assert.match(out, /"stop_reason":"end_turn"/);
});
