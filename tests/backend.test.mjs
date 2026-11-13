// Unit tests for the AI backend (netlify/edge-functions/ai.js) with both providers.
// The provider APIs are replaced by fakes, so no keys or network are needed.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { handle, provider, geminiToEvents, resetLimits, RATE, CODE_RATE, RETRY, STREAM } from "../netlify/edge-functions/ai.js";

const realFetch = globalThis.fetch;
let next = null, lastCall = null, calls = 0;
globalThis.fetch = async (url, init) => { calls++; lastCall = { url: String(url), init }; return next(); };
after(() => { globalThis.fetch = realFetch; });

// No real waiting between retries: the waits are recorded instead.
const realSleep = RETRY.sleep;
let waits = [];
RETRY.sleep = async ms => { waits.push(ms); };
after(() => { RETRY.sleep = realSleep; });

const VARS = ["AI_PROVIDER", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "ACCESS_CODE", "GEMINI_MODEL", "GEMINI_MODEL_QUICK", "ANTHROPIC_MODEL", "ANTHROPIC_MODEL_QUICK", "ALLOWED_ORIGINS"];
beforeEach(() => { for (const v of VARS) delete process.env[v]; next = null; lastCall = null; calls = 0; waits = []; resetLimits(); });

const post = (body, headers = {}, context) => handle(new Request("http://x/api/ai", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), context);
const get = (headers = {}, context) => handle(new Request("http://x/api/ai", { headers }), context);
const streamOf = (...chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });
async function readEvents(res) {
  const text = await res.text();
  return text.split("\n\n").filter(e => e.startsWith("data: ")).map(e => JSON.parse(e.slice(6)));
}
const lastError = async res => (await readEvents(res)).find(e => e.type === "error")?.error;

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
    [429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }, "rate_limited"],
    [400, { error: { code: 400, message: "API key not valid. Please pass a valid API key." } }, "bad_key"],
    [403, { error: { code: 403, status: "PERMISSION_DENIED" } }, "bad_key"],
    [404, { error: { code: 404, message: "models/x is not found" } }, "model_unavailable"],
    [400, { error: { code: 400, message: "Invalid value at generation_config" } }, "upstream_error"],
  ];
  for (const [status, body, code] of cases) {
    next = () => new Response(JSON.stringify(body), { status });
    const r = await post({ prompt: "x" });
    assert.equal(r.status, 200, "errors arrive inside the stream");
    const err = await lastError(r);
    assert.equal(err.type, code);
    assert.match(err.message, new RegExp(`^${status} [a-z ]+: `), "the status is labelled without the provider name");
    assert.doesNotMatch(err.message, /Gemini/);
  }
});

const busy503 = () => new Response(JSON.stringify({ error: { code: 503, message: "The model is overloaded." } }), { status: 503 });
const geminiOk = () => new Response(streamOf('data: {"candidates":[{"content":{"parts":[{"text":"{}"}]},"finishReason":"STOP"}]}\n\n'));
const modelOf = url => decodeURIComponent(url.match(/models\/([^:]+):/)[1]);

test("Gemini: retries with growing waits when the service is busy", async () => {
  process.env.GEMINI_API_KEY = "g";
  let n = 0;
  next = () => ++n <= 2 ? busy503() : geminiOk();
  const events = await readEvents(await post({ prompt: "x" }));
  assert.equal(calls, 3, "two busy answers, then success");
  assert.equal(events.find(e => e.type === "content_block_delta").delta.text, "{}");
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 2000 && waits[0] <= 2500 && waits[1] >= 5000 && waits[1] <= 5500, `backoff with a little jitter: ${waits}`);
  assert.match(lastCall.url, /gemini-3\.8-flash:/, "still the default model");
});

test("Gemini: falls back to the quick model once when the default stays busy", async () => {
  process.env.GEMINI_API_KEY = "g";
  const models = [];
  next = () => { const m = modelOf(lastCall.url); models.push(m); return m === "gemini-3.5-flash-lite" ? geminiOk() : busy503(); };
  const events = await readEvents(await post({ prompt: "x" }));
  assert.deepEqual(models, ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite"], "4 tries, then the quick model");
  assert.equal(events.find(e => e.type === "content_block_delta").delta.text, "{}");
  assert.equal(waits.length, 3);
  assert.ok(waits.reduce((a, b) => a + b) < 20000, "worst-case waiting stays well under Netlify's limits");

  // both stay busy: the first model's busy error is reported
  calls = 0; waits = []; models.length = 0;
  next = () => { models.push(modelOf(lastCall.url)); return models.at(-1) === "gemini-3.5-flash-lite" ? new Response('{"error":{"code":404,"message":"not found"}}', { status: 404 }) : busy503(); };
  const err = await lastError(await post({ prompt: "x" }));
  assert.equal(calls, 5);
  assert.equal(err.type, "busy", "a failing fallback doesn't hide that the service is busy");
  assert.match(err.message, /^503 unavailable: The model is overloaded/);

  // a quick request has no other model to fall back to
  calls = 0; models.length = 0;
  next = () => { models.push(modelOf(lastCall.url)); return busy503(); };
  assert.equal((await lastError(await post({ prompt: "x", tier: "quick" }))).type, "busy");
  assert.deepEqual(models, Array(4).fill("gemini-3.5-flash-lite"), "no fallback to the same model");

  // the same when GEMINI_MODEL_QUICK is set to the default model
  calls = 0; models.length = 0; process.env.GEMINI_MODEL_QUICK = "gemini-3.8-flash";
  await (await post({ prompt: "x" })).text();
  assert.equal(calls, 4);

  // other errors are not retried
  calls = 0;
  next = () => new Response('{"error":{"code":429,"message":"Quota"}}', { status: 429 });
  assert.equal((await lastError(await post({ prompt: "x" }))).type, "rate_limited");
  assert.equal(calls, 1);
});

test("Anthropic: retries when overloaded and falls back to its quick model", async () => {
  process.env.ANTHROPIC_API_KEY = "a"; process.env.ANTHROPIC_MODEL_QUICK = "claude-quick-test";
  const models = [];
  const sse = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{}"}}\n\n';
  next = () => { const m = JSON.parse(lastCall.init.body).model; models.push(m);
    return m === "claude-quick-test" ? new Response(streamOf(sse)) : new Response('{"error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 }); };
  const text = await (await post({ prompt: "x" })).text();
  assert.deepEqual(models, ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5", "claude-quick-test"]);
  assert.ok(text.endsWith(sse));
});

test("keeps the stream alive while waiting between retries", async () => {
  process.env.GEMINI_API_KEY = "g";
  const fake = RETRY.sleep, delays = RETRY.delaysMs, ping = STREAM.keepAliveMs;
  RETRY.sleep = realSleep; RETRY.delaysMs = [300]; STREAM.keepAliveMs = 50;
  let n = 0;
  next = () => ++n === 1 ? busy503() : geminiOk();
  try {
    const text = await (await post({ prompt: "x" })).text();
    assert.ok((text.match(/: keep-alive/g) || []).length >= 2, "keep-alive comments are sent during the wait");
    assert.match(text, /"text":"\{\}"/);
  } finally { RETRY.sleep = fake; RETRY.delaysMs = delays; STREAM.keepAliveMs = ping; }
});

test("starts the stream right away, before the AI answers", async () => {
  process.env.GEMINI_API_KEY = "g";
  let release;
  next = () => new Promise(r => { release = () => r(new Response(streamOf('data: {"candidates":[{"content":{"parts":[{"text":"{}"}]}}]}\n\n'))); });
  const res = await post({ prompt: "x" });
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /^: connected/, "headers and a first byte are sent before the provider answers");
  release();
  let rest = ""; for (;;) { const { value, done } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
  assert.match(rest, /"text":"\{\}"/);
});

test("turns a network failure into an error event", async () => {
  process.env.GEMINI_API_KEY = "g";
  next = () => { throw new Error("getaddrinfo ENOTFOUND"); };
  const err = await lastError(await post({ prompt: "x" }));
  assert.equal(err.type, "upstream_error");
  assert.match(err.message, /ENOTFOUND/);
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
  assert.ok((await res.text()).endsWith(sse));
  next = () => new Response('{"error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 });
  const err = await lastError(await post({ prompt: "x" }));
  assert.equal(err.type, "bad_key");
  assert.match(err.message, /invalid x-api-key/);
});

test("handles the stream helper directly", async () => {
  const out = await new Response(geminiToEvents(streamOf('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}'))).text();
  assert.match(out, /"text":"ok"/);
  assert.match(out, /"stop_reason":"end_turn"/);
});

const okStream = () => new Response(streamOf('data: {"candidates":[{"content":{"parts":[{"text":"{}"}]},"finishReason":"STOP"}]}\n\n'));

test("rejects oversized requests before parsing them, but fits the page's largest request", async () => {
  process.env.GEMINI_API_KEY = "g";
  next = okStream;
  // declared length too large: refused without reading the body
  const big = handle(new Request("http://x/api/ai", { method: "POST", headers: { "content-type": "application/json", "content-length": "5000000" }, body: "{" }));
  assert.equal((await big).status, 413);
  // no declared length (chunked): refused while reading
  const chunks = new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode("x".repeat(100000))); c.close(); } });
  const r = await handle(new Request("http://x/api/ai", { method: "POST", body: chunks, duplex: "half" }));
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, "prompt_too_large");
  assert.equal(calls, 0);
  // too many characters
  assert.equal((await post({ prompt: "x".repeat(200001) })).status, 413);
  // the page's largest request (an analysis part: 80,000 characters plus instructions), also with non-Latin text
  const res = await post({ prompt: "ä€\n\"".repeat(24000) });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(calls, 1);
});

test("allows the site's own origin and refuses other websites", async () => {
  process.env.GEMINI_API_KEY = "g";
  next = okStream;
  assert.equal((await post({ prompt: "x" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await get({ origin: "https://evil.example" })).status, 403);
  assert.equal(calls, 0);
  const own = await post({ prompt: "x" }, { origin: "http://x" });
  assert.equal(own.status, 200); await own.text();
  const none = await post({ prompt: "x" });
  assert.equal(none.status, 200, "requests without Origin (same-origin GET, tools) pass"); await none.text();
  process.env.ALLOWED_ORIGINS = "https://preview.example, https://other.example/";
  const extra = await post({ prompt: "x" }, { origin: "https://other.example" });
  assert.equal(extra.status, 200); await extra.text();
});

test("limits requests and wrong access codes per client", async () => {
  process.env.GEMINI_API_KEY = "g";
  next = okStream;
  const a = { ip: "1.2.3.4" }, b = { ip: "5.6.7.8" };
  assert.equal(RATE.max, 120, "room for a class on one shared IP");
  for (let i = 0; i < RATE.max; i++) { const r = await post({ prompt: "x" }, {}, a); assert.equal(r.status, 200); await r.text(); }
  const over = await post({ prompt: "x" }, {}, a);
  assert.equal(over.status, 429);
  assert.equal((await over.json()).error, "rate_limited");
  const status = await get({}, a);
  assert.equal(status.status, 200, "the status check is not blocked by the AI rate limit");
  assert.equal((await status.json()).ok, true);
  const other = await post({ prompt: "x" }, {}, b);
  assert.equal(other.status, 200, "other clients are not affected"); await other.text();

  process.env.ACCESS_CODE = "secret";
  assert.equal(CODE_RATE.max, 30);
  for (let i = 0; i < CODE_RATE.max - 1; i++) assert.equal((await (await get({ "x-access-code": "guess" + i }, b)).json()).codeOk, false);
  assert.equal((await (await get({ "x-access-code": "secret" }, b)).json()).codeOk, true, "a few wrong codes on a shared IP don't lock it");
  assert.equal((await (await get({ "x-access-code": "guess-last" }, b)).json()).codeOk, false);
  assert.equal((await get({ "x-access-code": "secret" }, b)).status, 429, "no more guessing after 30 wrong codes");
  assert.equal((await post({ prompt: "x" }, { "x-access-code": "secret" }, b)).status, 429);
  const plain = await get({}, b);
  assert.equal(plain.status, 200, "a status check without a code still answers during the lockout");
  assert.deepEqual(await plain.json(), { ok: true, provider: "gemini", needsCode: true, codeOk: false });
  assert.equal((await (await get({ "x-access-code": "secret" }, { ip: "9.9.9.9" })).json()).codeOk, true);
  assert.equal((await (await get({ "x-access-code": "secre" }, { ip: "9.9.9.9" })).json()).codeOk, false, "a prefix of the code is wrong");
});
