// End-to-end tests for Exam Coach.
// Runs the real page in Chromium with the site's security headers, serves the files
// from this repository, and answers /api/ai with the real backend code. Only the
// Anthropic API itself is replaced by a fake, so no API key or network is needed.
//
// Run: npm test   (first time: npm install && npx playwright install chromium)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { handle } from "../netlify/edge-functions/ai.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://exam-coach.test";
const CSP = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8").match(/Content-Security-Policy = "([^"]+)"/)[1];
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };

// ---- fake Anthropic API -------------------------------------------------------
const realFetch = globalThis.fetch;
const upstream = { calls: 0, models: [] };
function fakeAnswer(prompt) {
  if (prompt.includes("Split the content into"))
    return { topics: [
      { name: "Hypothesis tests", summary: "H0, H1, p-values, error types.", weight: 5, oldExamHits: 3, effortH: 4, sources: "Script p. 1" },
      { name: "Linear regression", summary: "Least squares and R squared.", weight: 3, oldExamHits: 1, effortH: 3, sources: "Script p. 1" }],
      style: "Mostly calculations with short definitions." };
  if (prompt.includes("Grade a student")) return [{ i: 1, score: 0.5, feedback: "Half right.", missed: "Type II error" }];
  if (prompt.includes("practice questions"))
    return { questions: [
      { type: "mc", question: "What is a Type I error?", options: ["Keeping H0", "Rejecting a true H0", "A wrong model", "A small sample"], answer: 1, modelAnswer: "Rejecting a true H0.", concept: "Type I error", source: "Script p. 1" },
      { type: "short", question: "Define a Type II error.", modelAnswer: "Keeping H0 although it is false.", concept: "Type II error", source: "Script p. 1" }] };
  if (prompt.includes("flashcards")) return { cards: [{ front: "What is H0?", back: "The null hypothesis." }, { front: "What does R squared measure?", back: "Explained variance." }] };
  return { verdict: "Good start.", covered: ["H0 and H1"], missing: ["Error types"], wrong: [] };
}
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith("https://api.anthropic.com/")) return realFetch(url, init);
  upstream.calls++;
  const body = JSON.parse(init.body);
  upstream.models.push(body.model);
  const text = "```json\n" + JSON.stringify(fakeAnswer(body.messages[0].content)) + "\n```";
  const parts = [text.slice(0, 15), text.slice(15)];
  const sse = [
    `event: message_start\ndata: {"type":"message_start"}\n\n`,
    ...parts.map(t => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })}\n\n`),
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ].join("");
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
};

// ---- browser with the site served from this repository -----------------------
let browser, context, page;
const problems = [];

async function serve(ctx) {
  await ctx.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== ORIGIN) { problems.push("external request: " + url.href); return route.abort(); }
    if (url.pathname === "/api/ai") {
      const res = await handle(new Request(req.url(), { method: req.method(), headers: req.headers(), body: req.method() === "POST" ? req.postData() : undefined }));
      return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
    }
    const file = path.join(ROOT, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    return route.fulfill({ status: 200, headers: { "content-type": type, "content-security-policy": CSP }, body: fs.readFileSync(file) });
  });
}
async function open(ctx) {
  const p = await ctx.newPage();
  p.on("pageerror", e => problems.push("page error: " + e.message));
  p.on("console", m => { if (m.type() === "error") problems.push("console: " + m.text()); });
  await p.goto(ORIGIN + "/");
  await p.waitForFunction(() => typeof aiState !== "undefined" && aiState !== "checking");
  return p;
}

before(async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ACCESS_CODE;
  browser = await chromium.launch();
  context = await browser.newContext({ acceptDownloads: true });
  await serve(context);
  page = await open(context);
});
after(async () => { await browser?.close(); globalThis.fetch = realFetch; });

// ---- tests ---------------------------------------------------------------------
test("loads with the AI backend connected", async () => {
  assert.equal(await page.evaluate(() => aiState), "ok");
  assert.match(await page.textContent("main"), /Try it with example exams/);
});

test("builds a plan from the example exams and keeps it after a reload", async () => {
  await page.click('[data-act="example"]');
  assert.equal(await page.evaluate(() => S.exams.length), 2);
  assert.ok(await page.evaluate(() => S.blocks.some(b => b.type === "learn" && b.method)), "learning blocks have study methods");
  assert.ok(await page.evaluate(() => S.blocks.some(b => b.type === "mock")), "plan has a mock exam");
  await page.waitForTimeout(1200); // saving is debounced
  await page.reload();
  await page.waitForFunction(() => aiState !== "checking");
  assert.equal(await page.evaluate(() => S.exams.length), 2);
});

test("reads an uploaded PDF and turns it into topics", async () => {
  await page.click('nav [data-view="exams"]');
  await page.selectOption("#mat-kind", "script");
  await page.setInputFiles("#mat-file", path.join(ROOT, "tests/fixtures/statistics-script.pdf"));
  await page.waitForFunction(() => S.exams[0].materials.length === 1, null, { timeout: 15000 });
  const text = await page.evaluate(() => getMaterial(S.exams[0].materials[0].id));
  assert.match(text, /Type I error/);
  await page.click('[data-act="analyze"]');
  await page.waitForFunction(() => S.exams[0].topics.some(t => t.name === "Hypothesis tests"));
  assert.deepEqual(await page.evaluate(() => S.exams[0].topics.map(t => t.weight)), [5, 3]);
});

test("generates and grades a quiz, and the plan reacts", async () => {
  const r = await page.evaluate(async () => {
    const e = S.exams[0], t = e.topics[0];
    await generateQuiz(e, t, 2);
    quiz.answers = { 0: 1, 1: "Keeping H0" };
    quiz.conf = { 0: "sure", 1: "sure" };
    await gradeQuiz();
    return { phase: quiz.phase, score: quiz.score, feedback: quiz.results[1].feedback, logged: S.log[0].kind, conf: S.fp.conf.length };
  });
  assert.equal(r.phase, "done");
  assert.equal(r.score, 75);
  assert.equal(r.feedback, "Half right.");
  assert.equal(r.logged, "quiz");
  assert.equal(r.conf, 2);
});

test("creates a flashcard study session", async () => {
  const r = await page.evaluate(async () => {
    const b = S.blocks.find(x => x.type === "learn" && x.status === "planned");
    b.method = "flashcards"; await genStudy(b);
    return ST[b.id].phase + ":" + ST[b.id].data.cards.length;
  });
  assert.equal(r, "ready:2");
});

test("shows the learning profile with example data", async () => {
  await page.evaluate(() => { loadDemoFingerprint(); go("you"); });
  const main = await page.textContent("main");
  assert.match(main, /Which study methods work for you/);
  assert.match(main, /Explain it back works best for you/);
});

test("downloads a calendar file and a backup that can be restored", async () => {
  const [ics] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => exportIcs())]);
  assert.equal(ics.suggestedFilename(), "exam-coach.ics");
  assert.match(fs.readFileSync(await ics.path(), "utf8"), /BEGIN:VCALENDAR[\s\S]*BEGIN:VEVENT/);

  const [bk] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => exportBackup())]);
  const backup = JSON.parse(fs.readFileSync(await bk.path(), "utf8"));
  assert.equal(backup.app, "exam-coach");

  const fresh = await browser.newContext();
  await serve(fresh);
  const p2 = await open(fresh);
  assert.equal(await p2.evaluate(() => S.exams.length), 0);
  await p2.evaluate(async d => { busy.restore = d; await restoreBackup(); }, backup);
  assert.equal(await p2.evaluate(() => S.exams.length), 2);
  assert.match(await p2.evaluate(() => getMaterial(S.exams[0].materials[0].id)), /Type I error/);
  await fresh.close();
});

test("asks for the access code when one is set", async () => {
  process.env.ACCESS_CODE = "study-group";
  await page.reload();
  await page.waitForFunction(() => aiState !== "checking");
  assert.equal(await page.evaluate(() => aiState), "code");
  await page.fill("#ai-code", "study-group");
  await page.click('[data-act="ai-code"]');
  await page.waitForFunction(() => aiState === "ok");
  delete process.env.ACCESS_CODE;
});

test("explains when the backend has no API key", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await page.reload();
  await page.waitForFunction(() => aiState !== "checking");
  assert.equal(await page.evaluate(() => aiState), "off");
  process.env.ANTHROPIC_API_KEY = "test-key";
});

test("makes no requests to other servers and has no errors", () => {
  assert.ok(upstream.calls >= 4, "the AI backend was called");
  assert.ok(upstream.models.every(m => typeof m === "string" && m.length > 0));
  assert.deepEqual(problems, []);
});
