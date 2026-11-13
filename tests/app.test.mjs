// End-to-end tests for Exam Coach.
// Runs the real page in Chromium with the site's security headers, serves the files
// from this repository, and answers /api/ai with the real backend code (Gemini provider).
// Only the Gemini API itself is replaced by a fake, so no API key or network is needed.
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
const upstream = { calls: 0, models: [], fail: null, prompts: [], maxPrompt: 0, delay: 0 };
function fakeAnswer(prompt) {
  const part = prompt.match(/This is part (\d+) of (\d+)/);
  if (part && prompt.includes("study topics in a sensible learning order")) {
    // Long materials: answer only with topics whose marker words appear in this part.
    const mat = prompt.slice(prompt.indexOf("MATERIALS:")), topics = [];
    // Same topic, differently written in each part: must be merged into one.
    topics.push({ name: +part[1] % 2 ? "Hypothesis tests" : " 1. hypothesis-Tests ", summary: "H0 and H1.", weight: +part[1] === 2 ? 5 : 3, oldExamHits: 2, effortH: 2, sources: `Part ${part[1]}` });
    if (mat.includes("ALPHAWORD")) topics.push({ name: "Sampling", summary: "Samples.", weight: 2, oldExamHits: 0, effortH: 1.5, sources: `Part ${part[1]}` });
    if (mat.includes("BETAWORD")) topics.push({ name: "Regression models", summary: "Lines.", weight: 4, oldExamHits: 1, effortH: 3, sources: `Part ${part[1]}` });
    // Prerequisite links, spread over the parts: one per part, a self-link, an unknown topic and a cycle.
    const h = topics[0];
    h.buildsOn = mat.includes("ALPHAWORD") ? ["sampling"] : mat.includes("BETAWORD") ? ["Regression models"] : ["Hypothesis tests"];
    if (mat.includes("BETAWORD")) topics[topics.length - 1].buildsOn = ["hypothesis-tests", "Not a topic"];
    // Old-exam tasks on the pages of this part; label spelling differs between parts. Task 4's topic
    // is only known once the part with BETAWORD was read.
    const tasks = [...mat.matchAll(/Task (\d+): test H0/g)].map(m => ({ label: +part[1] % 2 ? `Task ${m[1]}` : `task ${m[1]} `,
      topic: m[1] === "4" ? (mat.includes("BETAWORD") ? "Regression models" : "Not a topic") : topics[0].name, points: 10 }));
    return { topics, style: mat.includes("OLD EXAM") ? "Old exam: calculations." : "From the material.", tasks };
  }
  if (prompt.includes("Feynman method")) {
    // round 2 has the student's answers to the follow-up questions
    if (prompt.includes("The student's answers:")) return { reply: "Now I get it!", good: ["Answered the follow-up on error types"], gaps: [], questions: ["ignored in round 2"], score: 80, missed: [] };
    return { reply: "So H0 is the <b>default</b>? What happens if we reject it wrongly?", good: ["Clear idea of H0 and H1"],
      gaps: [{ point: "Didn't explain Type I and Type II errors", source: "notes.pdf p. 2" }, "No mention of p-values"],
      questions: ["What is a Type I error?", "How do you choose alpha?", "A third one that should be cut"], score: 55, missed: ["Type I error"] };
  }
  if (prompt.includes("short oral exam")) {
    const n = (prompt.match(/^STUDENT: /gm) || []).length;
    if (n < 3) return { end: false, question: n === 0 ? "Hello. What is a null hypothesis?" : `Question ${n + 1}: you said "${prompt.match(/STUDENT: ([^\n]*)\n*(?![\s\S]*STUDENT: )/)[1]}". Why?` };
    return { end: true, score: 70, summary: "Solid basics, unsure about error types.", strengths: ["Defines H0 clearly"], improve: ["Type II error"], missed: ["Type II error"] };
  }
  if (prompt.includes("study topics in a sensible learning order"))
    return { topics: [
      { name: "Hypothesis tests", summary: "H0, H1, p-values, error types.", weight: 5, oldExamHits: 3, effortH: 4, sources: "Script p. 1" },
      { name: "Linear regression", summary: "Least squares and R squared.", weight: 3, oldExamHits: 1, effortH: 3, sources: "Script p. 1", buildsOn: ["Hypothesis tests", "Unknown topic"] }],
      style: "Mostly calculations with short definitions.",
      tasks: [{ label: "Task 1", topic: "Hypothesis tests", points: 30 }, { label: "Task 2", topic: "Linear regression", points: 20 }] };
  if (prompt.includes("Grade a student")) return [{ i: 1, score: 0.5, feedback: "Half right.", missed: "Type II error" }];
  if (prompt.includes("practice questions"))
    return { questions: [
      { type: "mc", question: "What is a Type I error?", options: ["Keeping H0", "Rejecting a true H0", "A wrong model", "A small sample"], answer: 1, modelAnswer: "Rejecting a true H0.", concept: "Type I error", source: "Script p. 1" },
      { type: "short", question: "Define a Type II error.", modelAnswer: "Keeping H0 although it is false.", concept: "Type II error", source: "Script p. 1" }] };
  if (prompt.includes("flashcards")) return { cards: [{ front: "What is H0?", back: "The null hypothesis." }, { front: "What does R squared measure?", back: "Explained variance." }] };
  return { verdict: "Good start.", covered: ["H0 and H1"], missing: ["Error types"], wrong: [] };
}
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith("https://generativelanguage.googleapis.com/")) return realFetch(url, init);
  upstream.calls++;
  upstream.models.push(decodeURIComponent(String(url).match(/models\/([^:]+):/)[1]));
  if (upstream.fail) return new Response(JSON.stringify({ error: { code: upstream.fail, message: "Simulated failure" } }), { status: upstream.fail });
  if (init.headers["x-goog-api-key"] !== "test-key") return new Response(JSON.stringify({ error: { code: 400, message: "API key not valid" } }), { status: 400 });
  const body = JSON.parse(init.body), prompt = body.contents[0].parts[0].text;
  upstream.prompts.push(prompt);
  if (upstream.delay) await new Promise(r => setTimeout(r, upstream.delay));
  if (upstream.maxPrompt && prompt.length > upstream.maxPrompt) return new Response(JSON.stringify({ error: { code: 400, message: "The input token count exceeds the maximum number of tokens allowed" } }), { status: 400 });
  const text = JSON.stringify(fakeAnswer(prompt));
  const parts = [text.slice(0, 15), text.slice(15)];
  const sse = parts.map((t, i) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: t }] }, ...(i === parts.length - 1 ? { finishReason: "STOP" } : {}) }] })}\r\n\r\n`).join("");
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
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AI_PROVIDER;
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
  // learning follows the material, with the example's prerequisite links, in both modes
  const seq = mode => page.evaluate(m => { const e = S.exams[0]; e.mode = m; replan();
    return [...new Set(S.blocks.filter(b => b.examId === e.id && b.type === "learn").map(b => topicById(e, b.topicId).name))]; }, mode);
  assert.deepEqual(await seq("top"), ["Descriptive statistics", "Probability basics", "Random variables & distributions", "Normal distribution & CLT", "Confidence intervals", "Hypothesis tests", "Linear regression"],
    "top grade: material order");
  const pass = await seq("pass");
  const needed = await page.evaluate(() => { const P = pointsTable(S.exams[0]); return S.exams[0].topics.filter(t => P.rows.find(r => r.t.id === t.id).needed).map(t => t.name); });
  assert.ok(needed.length >= 1 && needed.length < 7);
  assert.deepEqual(pass.slice(0, needed.length), needed, "pass: the needed topics first, in material order");
  assert.deepEqual(pass.slice(needed.length), (await seq("top")).filter(n => !needed.includes(n)), "then the rest in material order");
  assert.ok(pass.indexOf("Probability basics") < pass.indexOf("Hypothesis tests"));
  await page.evaluate(() => { S.exams[0].mode = "top"; commit({ plan: true }); });
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
  assert.deepEqual(await page.evaluate(() => S.exams[0].oldTasks.map(x => [x.label, topicById(S.exams[0], x.topicId).name, x.points])),
    [["Task 1", "Hypothesis tests", 30], ["Task 2", "Linear regression", 20]]);
  assert.deepEqual(await page.evaluate(() => S.exams[0].topics.map(t => t.prereqs.map(id => topicById(S.exams[0], id).name))), [[], ["Hypothesis tests"]], "links from the AI, unknown topics dropped");
  assert.match(await page.evaluate(() => S.log[0].detail), /found 1 link between topics/);
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

test("shows what the coach changed on the quiz results page right after a normal quiz", async () => {
  await page.evaluate(() => { window.__saved = JSON.stringify({ S, quiz }); });
  await page.click('#nav [data-view="quiz"]');
  await page.click('[data-act="gen"]');
  await page.waitForSelector('[data-act="submit"]');
  await page.check('#q0-1'); await page.fill('#qa-1', 'Keeping a false H0');
  await page.click('[data-act="submit"]');
  await page.waitForFunction(() => quiz && quiz.phase === "done");
  const main = await page.textContent("main");
  assert.match(main, /What the coach changed/);
  assert.match(main, /Expected at this point: \d+%/);
  assert.equal(await page.locator('main [data-view="plan"]', { hasText: "See updated plan" }).count(), 1);
  // leave the shared state as it was for the later tests
  await page.evaluate(() => { const x = JSON.parse(window.__saved); Object.assign(S, x.S); quiz = x.quiz; commit(); go("dashboard"); });
});

test("a low score on a topic not learned yet isn't called behind or on track, and changes nothing", async () => {
  const r = await page.evaluate(() => {
    const before = JSON.stringify(S);
    const e = S.exams[0];
    // a topic with no study time done and no quiz yet, among the heaviest (so it holds an eve review slot)
    const t = [...e.topics].filter(x => x.mastery == null && learnProgress(x) === 0).sort((a, b) => b.weight - a.weight)[0];
    const eve = () => S.blocks.filter(b => b.examId === e.id && b.status === "planned" && b.label.startsWith("Final review")).map(b => b.topicId).sort().join();
    commit(); const eve0 = eve();
    const c = applyQuizResult(e, t, 10, []);
    const out = { detail: c.detail, title: c.title, changes: c.changes, eveSame: eve() === eve0, extra: t.extraMin || 0 };
    // a later replan that does move hours: the message must not claim the plan stays
    out.keepMoved = keepText([{ name: "x", exam: "y", delta: 60 }]);
    const s = JSON.parse(before); Object.assign(S, s); commit();
    return out;
  });
  assert.match(r.title, /10% \(expected 0%\)/);
  assert.match(r.detail, /^Not learned yet \(0% of its study time done\), so this doesn't count as behind; its learning time stays in the plan\./);
  assert.doesNotMatch(r.detail, /On track/);
  assert.deepEqual(r.changes, [], "the eve review isn't moved by a result that changes nothing");
  assert.ok(r.eveSame);
  assert.equal(r.extra, 0);
  assert.match(r.detail, /The plan stays as it is\.$/);
  assert.doesNotMatch(r.keepMoved, /plan stays as it is/);
});

test("scores a mock exam per task and the plan reacts", async () => {
  // Hypothesis tests is fully learned, so its mock result is compared with the full target
  await page.evaluate(() => { const e = S.exams[0], t = e.topics[0];
    S.blocks.push({ id: uid(), examId: e.id, topicId: t.id, type: "learn", status: "done", date: today(), start: "06:00", minutes: needLearn(t), label: "Learn: " + t.name }); commit();
    openMock(S.blocks.find(b => b.examId === e.id && b.type === "mock")); });
  assert.equal(await page.inputValue("#mk-max-0"), "30", "pre-filled from the old-exam tasks");
  assert.equal(await page.inputValue("#mk-max-1"), "20");
  await page.fill("#mk-got-0", "9");
  await page.fill("#mk-got-1", "18");
  assert.equal(await page.textContent("#mk-total"), "27 of 50 points");
  const before = await page.evaluate(() => S.exams[0].topics.map(t => t.extraMin || 0));
  await page.click('[data-act="mk-save"]');
  const r = await page.evaluate(() => {
    const e = S.exams[0], b = S.blocks.find(x => x.examId === e.id && x.type === "mock" && x.mock);
    return { status: b && b.status, tasks: b && b.mock.tasks.length, log: S.log[0], extra: e.topics.map(t => t.extraMin || 0), due: e.topics[0].reviewDue, tomorrow: addDays(today(), 1) };
  });
  assert.equal(r.status, "done");
  assert.equal(r.tasks, 2);
  assert.equal(r.log.kind, "mock");
  assert.match(r.log.title, /mock exam 27\/50 points \(54%\)/);
  assert.match(r.log.detail, /Below plan: Hypothesis tests 30%/);
  assert.ok(r.extra[0] > before[0], "weak topic gets extra time");
  assert.equal(r.due, r.tomorrow, "repair review tomorrow");
  assert.ok(r.log.changes.some(c => c.name === "Hypothesis tests" && c.delta > 0), "plan change is logged per topic");
  assert.match(await page.textContent("main"), /What the coach changed/);
  // the mock's task points now also feed the points estimate
  assert.equal(await page.evaluate(() => topicPoints(S.exams[0]).source), "old-exam tasks");
  // no second mock exam is planned once one is done
  assert.equal(await page.evaluate(() => { replan(); return S.blocks.filter(b => b.examId === S.exams[0].id && b.type === "mock").length; }), 1);

  // a scored mock can't be undone, but its results can be edited without counting twice
  const state = () => page.evaluate(() => { const e = S.exams[0];
    return { extra: e.topics.map(t => t.extraMin || 0), mastery: e.topics.map(t => t.mastery), mocks: e.topics.map(t => t.quizzes.filter(q => q.mock).length), due: e.topics.map(t => t.reviewDue) }; });
  const after1 = await state();
  await page.evaluate(() => go("plan"));
  const mockId = await page.evaluate(() => S.blocks.find(b => b.examId === S.exams[0].id && b.mock).id);
  await page.click(`[data-act="undo"][data-id="${mockId}"]`);
  assert.equal(await page.evaluate(id => S.blocks.find(b => b.id === id).status, mockId), "done");
  assert.match(await page.textContent("#toast"), /can't be undone/);
  await page.evaluate(id => openMock(S.blocks.find(b => b.id === id)), mockId);
  await page.click('[data-act="mk-edit"]');
  assert.equal(await page.inputValue("#mk-got-0"), "9", "the form shows the saved points");
  await page.click('[data-act="mk-save"]');
  assert.deepEqual(await state(), after1, "saving the same points again changes nothing");
  assert.match(await page.evaluate(() => S.log[0].title), /mock exam corrected to 27\/50 points/);
  await page.click('[data-act="mk-edit"]');
  await page.fill("#mk-got-0", "30");
  await page.click('[data-act="mk-save"]');
  const after2 = await state();
  assert.ok(after2.extra[0] <= before[0], "the earlier repair time is taken back, not added to");
  assert.deepEqual(after2.mocks, after1.mocks, "one mock result per topic, not two");
  assert.notEqual(after2.due[0], r.tomorrow, "the repair review from the old result is gone");
  // back to the first result for the tests below
  await page.click('[data-act="mk-edit"]');
  await page.fill("#mk-got-0", "9");
  await page.click('[data-act="mk-save"]');
  assert.deepEqual(await state(), after1);
});

// Learning blocks of an exam in plan order: no topic starts before the topics it builds on are done.
const prereqOrderOk = examIndex => page.evaluate(i => {
  const e = S.exams[i], L = S.blocks.filter(b => b.examId === e.id && b.type === "learn" && b.status === "planned"), first = {}, last = {};
  L.forEach((b, k) => { if (!(b.topicId in first)) first[b.topicId] = k; last[b.topicId] = k; });
  return e.topics.every(t => t.prereqs.every(p => !(p in last) || !(t.id in first) || last[p] < first[t.id]));
}, examIndex);
const learnSeq = examIndex => page.evaluate(i => {
  const e = S.exams[i];
  return [...new Set(S.blocks.filter(b => b.examId === e.id && b.type === "learn" && b.status === "planned").map(b => topicById(e, b.topicId).name))];
}, examIndex);

test("shows points per hour and plans by pass or top-grade mode", async () => {
  await page.evaluate(() => { const e = S.exams[1]; delete e.mode; delete e.passPct; normalize(); selExam = e.id; go("exams"); });
  assert.deepEqual(await page.evaluate(() => [S.exams[1].mode, S.exams[1].passPct]), ["top", 50]);
  const firstLearn = () => page.evaluate(() => {
    const e = S.exams[1], b = S.blocks.find(x => x.examId === e.id && x.type === "learn" && x.status === "planned");
    return topicById(e, b.topicId).name;
  });
  const pph = await page.evaluate(() => pointsTable(S.exams[1]).rows.map(r => r.pph));
  assert.deepEqual(pph, [...pph].sort((a, b) => b - a), "sorted by points per hour");
  assert.equal(await page.locator("#pph-table tbody tr").count(), 6);
  assert.deepEqual(await learnSeq(1), ["Supply & demand", "Elasticities", "Consumer theory", "Production & costs", "Market forms", "Market failure"], "top grade follows the material");

  await page.check("#mode-pass");
  assert.equal(await page.evaluate(() => S.exams[1].mode), "pass");
  assert.match(await page.evaluate(() => S.log[0].title), /aiming for a pass/);
  const passSeq = await learnSeq(1), notNeeded = await page.evaluate(() => pointsTable(S.exams[1]).rows.filter(r => !r.needed).map(r => r.t.name));
  assert.ok(notNeeded.includes("Consumer theory"));
  assert.ok(passSeq.indexOf("Market forms") < passSeq.indexOf("Consumer theory"), "topics needed for a pass come first");
  assert.equal(passSeq[0], "Supply & demand", "needed topics in material order");
  assert.ok(await page.locator("#pph-table >> text=After the pass").count() > 0, "topics beyond the pass mark are marked");
  const needed50 = await page.evaluate(() => pointsTable(S.exams[1]).rows.filter(r => r.needed).length);

  await page.fill("#f-pass", "90");
  await page.press("#f-pass", "Tab");
  assert.equal(await page.evaluate(() => S.exams[1].passPct), 90);
  assert.ok(await page.evaluate(() => pointsTable(S.exams[1]).rows.filter(r => r.needed).length) > needed50, "a higher pass mark needs more topics");

  await page.check("#mode-top");
  assert.equal(await page.evaluate(() => S.exams[1].mode), "top");
  assert.equal(await firstLearn(), "Supply & demand");
});

test("learns prerequisites first in top-grade and pass mode, and lets you edit the links", async () => {
  const id = await page.evaluate(() => { const e = S.exams[1]; selExam = e.id; go("exams"); return Object.fromEntries(e.topics.map(t => [t.name, t.id])); });
  assert.equal((await learnSeq(1))[0], "Supply & demand", "top grade starts at the beginning of the material");
  assert.ok(await prereqOrderOk(1), "the example's own links are respected");
  // Supply & demand builds on Consumer theory, which comes later in the material: the link wins
  await page.selectOption(`#t-p-${id["Supply & demand"]}`, [id["Consumer theory"]]);
  assert.match(await page.evaluate(() => S.log[0].title), /Supply & demand builds on Consumer theory/);
  assert.deepEqual((await learnSeq(1)).slice(0, 3), ["Consumer theory", "Supply & demand", "Elasticities"], "prerequisites are pulled in front, then the material order");
  assert.ok(await prereqOrderOk(1));
  assert.equal(await page.locator(`#t-p-${id["Consumer theory"]} option[value="${id["Supply & demand"]}"]`).count(), 0, "a topic can't build on a topic that builds on it");
  assert.equal(await page.locator(`#t-p-${id["Consumer theory"]} option[value="${id["Elasticities"]}"]`).count(), 0, "not even indirectly");

  await page.check("#mode-pass");
  assert.equal((await learnSeq(1))[0], "Consumer theory", "in pass mode too");
  assert.ok(await prereqOrderOk(1));
  const row = await page.evaluate(() => pointsTable(S.exams[1]).rows.find(r => r.t.name === "Consumer theory"));
  assert.deepEqual([row.needed, row.first], [true, "Supply & demand"], "a prerequisite of a needed topic is needed too");
  assert.match(await page.textContent("#pph-table"), /Supply & demand builds on it/);

  await page.check("#mode-top");
  assert.ok(await prereqOrderOk(1));
  // links removed again for the tests below
  await page.evaluate(() => { for (const t of S.exams[1].topics) t.prereqs = []; commit(); });
  assert.equal((await learnSeq(1))[0], "Supply & demand");
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

// Long material for the chunking tests: 60 pages of ~3000 characters. The first pages
// mention ALPHAWORD, the last ones BETAWORD, so they end up in different parts.
const longMaterial = () => Array.from({ length: 60 }, (_, i) => `\n=== p. ${i + 1} ===\n` + (i < 10 ? "ALPHAWORD " : i >= 50 ? "BETAWORD " : "") + "Statistics text. ".repeat(175)).join("");
const oldExamText = () => Array.from({ length: 4 }, (_, i) => `\n=== p. ${i + 1} ===\nTask ${i + 1}: test H0 against H1. ` + "Compute the p-value. ".repeat(60)).join("");
async function examWithMaterials(mats) {
  return page.evaluate(async mats => {
    newExam(); const e = examById(selExam);
    for (const m of mats) { const id = uid(); await putMaterial(id, { name: m.name, kind: m.kind, text: m.text }); e.materials.push({ id, name: m.name, kind: m.kind, pages: 60, chars: m.text.length, truncated: false, empty: false }); }
    commit({ plan: false });
    return e.id;
  }, mats);
}

test("splits long materials into parts, shows progress and merges the topics", async () => {
  const id = await examWithMaterials([{ name: "slides.pdf", kind: "slides", text: longMaterial() }, { name: "old.pdf", kind: "oldexam", text: oldExamText() }]);
  upstream.prompts = []; upstream.delay = 300;
  await page.evaluate(id => { analyzeMaterials(examById(id)); }, id);
  await page.waitForFunction(() => /Reading part 2 of 3…/.test(document.querySelector("#analyze-progress")?.textContent || ""));
  await page.waitForFunction(() => !busy.analyze, null, { timeout: 20000 });
  upstream.delay = 0;
  const parts = upstream.prompts.filter(p => /This is part \d of 3/.test(p));
  assert.equal(parts.length, 3, "three requests, one per part");
  assert.ok(parts.every(p => p.length < 90000), "each request stays within the budget");
  assert.ok(parts.every(p => p.includes("OLD EXAM: old.pdf")), "old exams go into every part");
  assert.match(parts[1], /Topics found in earlier parts: Hypothesis tests; Sampling/);
  const e = await page.evaluate(id => { const e = examById(id); return { topics: e.topics.map(t => ({ name: t.name, weight: t.weight, hits: t.oldExamHits, effortH: t.effortH })), style: e.style }; }, id);
  assert.deepEqual(e.topics.map(t => t.name), ["Hypothesis tests", "Sampling", "Regression models"]);
  const h = e.topics[0];
  assert.equal(h.weight, 5, "highest weight of the parts");
  assert.equal(h.hits, 2, "old-exam hits are not counted twice when every part saw the old exams");
  assert.equal(h.effortH, 6, "effort adds up over the parts");
  assert.equal(e.style, "Old exam: calculations.");
  // every part saw the same old exam: its tasks are merged, not multiplied
  assert.deepEqual(await page.evaluate(id => { const e = examById(id); return e.oldTasks.map(x => [x.label, topicById(e, x.topicId)?.name || null, x.points]); }, id),
    [["Task 1", "Hypothesis tests", 10], ["Task 2", "Hypothesis tests", 10], ["Task 3", "Hypothesis tests", 10], ["Task 4", "Regression models", 10]]);
});

test("merges prerequisite links across parts and drops unknown topics and cycles", async () => {
  const id = await examWithMaterials([{ name: "slides.pdf", kind: "slides", text: longMaterial() }, { name: "old.pdf", kind: "oldexam", text: oldExamText() }]);
  upstream.prompts = [];
  await page.evaluate(id => analyzeMaterials(examById(id)), id);
  const parts = upstream.prompts.filter(p => /This is part \d of 3/.test(p));
  assert.ok(parts.every(p => p.includes('"buildsOn"')), "every part asks for prerequisite links");
  assert.match(parts[2], /from this part or the topics found in earlier parts/);
  const links = await page.evaluate(id => { const e = examById(id); return Object.fromEntries(e.topics.map(t => [t.name, t.prereqs.map(p => topicById(e, p).name)])); }, id);
  // part 1: Hypothesis tests → Sampling; part 2: a self-link; part 3: Regression models → Hypothesis tests,
  // an unknown topic, and Hypothesis tests → Regression models, which would close a loop
  assert.deepEqual(links, { "Hypothesis tests": ["Sampling"], "Sampling": [], "Regression models": ["Hypothesis tests"] });
  assert.match(await page.evaluate(() => S.log[0].detail), /found 2 links between topics/);
  // a link the student set by hand survives re-analysis
  await page.evaluate(id => { const e = examById(id), s = e.topics.find(t => t.name === "Sampling"); s.prereqs = [e.topics.find(t => t.name === "Regression models").id]; s.prereqsSet = true; }, id);
  await page.evaluate(id => analyzeMaterials(examById(id)), id);
  const again = await page.evaluate(id => { const e = examById(id); return Object.fromEntries(e.topics.map(t => [t.name, t.prereqs.map(p => topicById(e, p).name)])); }, id);
  assert.deepEqual(again.Sampling, ["Regression models"]);
  assert.deepEqual(again["Hypothesis tests"], [], "the AI's link that would now close a loop is dropped");
});

test("collects old-exam tasks from the parts when a long old exam is split", async () => {
  const bigOld = Array.from({ length: 30 }, (_, i) => `\n=== p. ${i + 1} ===\nTask ${i + 1}: test H0 against H1. ` + "Compute the p-value. ".repeat(140)).join("");
  const id = await examWithMaterials([{ name: "slides.pdf", kind: "slides", text: longMaterial() }, { name: "big-old.pdf", kind: "oldexam", text: bigOld }]);
  upstream.prompts = [];
  await page.evaluate(id => analyzeMaterials(examById(id)), id);
  const parts = upstream.prompts.filter(p => /This is part \d of \d/.test(p));
  assert.ok(parts.length > 2 && !parts.every(p => p.includes("OLD EXAM: big-old.pdf")), "the old exam is split, not put into every part");
  assert.match(parts.find(p => p.includes("OLD EXAM")), /tasks of the most recent old exam that are in this part/);
  const tasks = await page.evaluate(id => { const e = examById(id); return e.oldTasks.map(x => [x.label, topicById(e, x.topicId)?.name || null]); }, id);
  assert.equal(tasks.length, 30, "each task once");
  assert.deepEqual(tasks.map(t => t[0].toLowerCase()), Array.from({ length: 30 }, (_, i) => `task ${i + 1}`), "in exam order");
  assert.ok(tasks.filter((t, i) => i !== 3).every(t => t[1] === "Hypothesis tests"), "mapped to the merged topic");
});

test("tries again with smaller parts when a request is too large", async () => {
  const id = await examWithMaterials([{ name: "slides.pdf", kind: "slides", text: longMaterial() }, { name: "old.pdf", kind: "oldexam", text: oldExamText() }]);
  upstream.prompts = []; upstream.maxPrompt = 50000;
  await page.evaluate(id => analyzeMaterials(examById(id)), id);
  upstream.maxPrompt = 0;
  assert.ok(upstream.prompts[0].length > 50000, "first try used large parts");
  const retried = upstream.prompts.slice(1);
  assert.ok(retried.length > 3 && retried.every(p => p.length <= 50000), "second try used smaller parts");
  assert.deepEqual(await page.evaluate(id => examById(id).topics.map(t => t.name), id), ["Hypothesis tests", "Sampling", "Regression models"]);
});

test("explains that scanned PDFs can't be read instead of asking the AI", async () => {
  await page.evaluate(() => newExam());
  await page.selectOption("#mat-kind", "oldexam");
  await page.setInputFiles("#mat-file", path.join(ROOT, "tests/fixtures/scanned-exam.pdf"));
  await page.waitForFunction(() => examById(selExam).materials.length === 1, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => examById(selExam).materials[0].empty), true);
  assert.match(await page.textContent("#toast"), /"scanned-exam\.pdf" has almost no text.*scanned PDFs can't be read yet/);
  const before = upstream.calls;
  await page.evaluate(() => { toast(""); return analyzeMaterials(examById(selExam)); });
  assert.equal(upstream.calls, before, "no request was sent");
  assert.match(await page.textContent("#toast"), /scanned PDFs can't be read yet/);
  assert.match(await page.textContent("main"), /scanned\? no text found/);
});

test("asks for energy before a focus session and offers a lighter session when low", async () => {
  await page.evaluate(() => go("dashboard"));
  const id = await page.evaluate(() => {
    const b = S.blocks.find(x => x.type === "learn" && x.status === "planned" && x.method && x.method !== "flashcards");
    startFocus(b.id); return b.id;
  });
  assert.equal(await page.evaluate(() => TM.phase), "checkin");
  assert.match(await page.textContent("#timer"), /How is your energy right now\?/);
  await page.click('#timer [data-t="energy"][data-v="low"]');
  assert.equal(await page.evaluate(() => TM.phase), "lighter");
  assert.match(await page.textContent("#timer"), /flashcards on this topic instead of new material/);
  await page.click('#timer [data-t="light-yes"]');
  const r = await page.evaluate(id => {
    const b = S.blocks.find(x => x.id === id), x = S.fp.energy[S.fp.energy.length - 1];
    return { phase: TM.phase, min: TM.dur / 60000, light: lightFocusMin(), view, method: studyMethod(b), v: x.v, lighter: x.light, topic: x.topicId === b.topicId };
  }, id);
  assert.deepEqual(r, { phase: "focus", min: r.light, light: 15, view: "study", method: "flashcards", v: "low", lighter: true, topic: true });
  assert.match(await page.textContent("main"), /Lighter session/);
  // the finished session is recorded with its energy level, and the next session doesn't ask again
  const s = await page.evaluate(() => { TM.endsAt = Date.now() - 1; phaseEnd(); const last = S.fp.sessions[S.fp.sessions.length - 1]; tmNext(); const ph = TM.phase; tmStop(); return { energy: last.energy, light: last.light, min: last.min, next: ph }; });
  assert.deepEqual(s, { energy: "low", light: true, min: 15, next: "focus" });
});

test("checks in on the study page and links energy to quiz results", async () => {
  const id = await page.evaluate(() => {
    const done = new Set(S.fp.energy.filter(x => !x.demo).map(x => x.topicId));
    const b = S.blocks.find(x => x.type === "learn" && x.status === "planned" && x.method && !done.has(x.topicId));
    studyId = b.id; go("study"); return b.id;
  });
  assert.match(await page.textContent("main"), /How is your energy right now\?/);
  await page.click('main [data-act="energy"][data-v="high"]');
  assert.doesNotMatch(await page.textContent("main"), /How is your energy right now\?|Go lighter/);
  const q = await page.evaluate(id => {
    const b = S.blocks.find(x => x.id === id), e = examById(b.examId), t = topicById(e, b.topicId);
    logQuiz(e, t, 80, "other"); return S.fp.quizLog[S.fp.quizLog.length - 1].energy;
  }, id);
  assert.equal(q, "high");
  await page.evaluate(() => go("you"));
  const main = await page.textContent("main");
  assert.match(main, /Your energy and your results/);
  assert.match(main, /On low-energy days you score \d+% on quizzes/);
});

test("keeps Go lighter sessions out of the study-method comparison", async () => {
  const r = await page.evaluate(() => {
    const b = S.blocks.find(x => x.type === "learn" && x.status === "planned" && blockEnergy(x) && blockEnergy(x).light);
    const e = examById(b.examId), t = topicById(e, b.topicId), m = t.method;
    const n0 = fingerprint().methods.find(x => x.m === m).n;
    markDone(b);
    const pendingLight = fingerprint().methods.find(x => x.m === m).pending;
    logQuiz(e, t, 95, "retention");
    const q = S.fp.quizLog[S.fp.quizLog.length - 1], fp = fingerprint().methods.find(x => x.m === m);
    // a normal topic with the same method still counts
    const other = allTopics().find(x => x.t.id !== t.id && !wentLighter(x.t));
    const saved = { method: other.t.method, retention: other.t.retention, checkPending: other.t.checkPending };
    other.t.method = m; logQuiz(other.e, other.t, 70, "retention");
    const n2 = fingerprint().methods.find(x => x.m === m).n;
    S.fp.quizLog.pop(); Object.assign(other.t, saved);
    return { light: b.light, wentLighter: wentLighter(t), qLight: q.light, n0, n1: fp.n, n2, rate: busy.rate === b.id };
  });
  assert.equal(r.light, true, "the done block remembers it was lighter");
  assert.equal(r.qLight, true, "the retention check is marked");
  assert.equal(r.n1, r.n0, "the lighter topic doesn't count for its method");
  assert.equal(r.n2, r.n0 + 1, "other topics with the method still count");
  assert.equal(r.rate, false, "no enjoyment rating for a lighter block");
});

test("puts repair time on a weak prerequisite first, for quizzes and mock exams", async () => {
  const r = await page.evaluate(() => {
    newExam(); const e = examById(selExam); e.subject = "Algebra";
    const B = mkTopic("Fractions", 3, 2), A = mkTopic("Equations", 3, 2), U = mkTopic("Units", 3, 2), P = mkTopic("Word problems", 3, 2), G = mkTopic("Graphs", 3, 2);
    e.topics.push(B, A, U, P, G); A.prereqs = [B.id]; P.prereqs = [U.id]; G.prereqs = [B.id];
    B.mastery = 45; B.quizzes = [{ date: today(), score: 45 }];
    G.mastery = 90;
    const learned = t => S.blocks.push({ id: uid(), examId: e.id, topicId: t.id, type: "learn", status: "done", date: today(), start: "06:00", minutes: 120, label: "Learn: " + t.name });
    learned(A); learned(P);
    commit();
    const out = {};
    // quiz: the prerequisite was quizzed and is weak
    const q = applyQuizResult(e, A, 40, ["solving for x"]);
    out.quiz = { detail: q.detail, bExtra: B.extraMin, aExtra: A.extraMin, bDue: B.reviewDue, aDue: A.reviewDue, bChange: q.changes.some(c => c.name === "Fractions" && c.delta > 0),
      reviews: S.blocks.filter(b => b.examId === e.id && b.status === "planned" && /^Repair review/.test(b.label)).map(b => [b.label, b.date]) };
    // quiz: the prerequisite wasn't quizzed and isn't fully learned yet
    out.untested = applyQuizResult(e, P, 30, []).detail;
    out.uExtra = U.extraMin;
    // quiz: strong result on a topic with a weak prerequisite changes nothing about the prerequisite
    const b0 = B.extraMin; applyQuizResult(e, G, 90, []); out.strongKeeps = B.extraMin === b0;
    // mock exam: tasks listed with the dependent topic first; the prerequisite is handled first and repaired once
    // Fractions is learned by now, so its mock result is compared with the full target
    learned(B);
    const before = { a: A.extraMin, b: B.extraMin };
    const mb = { id: uid(), examId: e.id, type: "mock", status: "planned", date: today(), start: "07:00", minutes: 90, label: "Mock exam" };
    S.blocks.push(mb);
    const m = applyMockResult(mb, [{ label: "Task 1", topicId: A.id, max: 10, got: 2 }, { label: "Task 2", topicId: B.id, max: 10, got: 3 }]);
    out.mock = { detail: m.detail, kind: m.kind, aDelta: A.extraMin - before.a, bDelta: B.extraMin - before.b, aDue: A.reviewDue, bDue: B.reviewDue };
    out.t1 = addDays(today(), 1); out.t2 = addDays(today(), 2);
    out.order = (() => { const L = S.blocks.filter(b => b.examId === e.id && b.type === "learn" && b.status === "planned"), first = {}, last = {};
      L.forEach((b, k) => { if (!(b.topicId in first)) first[b.topicId] = k; last[b.topicId] = k; });
      return e.topics.every(t => t.prereqs.every(p => !(p in last) || !(t.id in first) || last[p] < first[t.id])); })();
    // clean up for the tests below
    S.exams = S.exams.filter(x => x !== e); S.blocks = S.blocks.filter(b => b.examId !== e.id); selExam = null; commit();
    return out;
  });
  assert.match(r.quiz.detail, /Your trouble with Equations probably comes from Fractions — reviewing Fractions first\./);
  assert.match(r.quiz.detail, /Added 30 min|Added 0\.5 h/);
  assert.deepEqual([r.quiz.bExtra, r.quiz.aExtra], [30, 30], "most of the repair time goes to the prerequisite");
  assert.deepEqual([r.quiz.bDue, r.quiz.aDue], [r.t1, r.t2], "prerequisite reviewed first");
  assert.ok(r.quiz.bChange, "the plan-change log shows the prerequisite's extra time");
  const rv = Object.fromEntries(r.quiz.reviews);
  assert.ok(rv["Repair review: Fractions"] && rv["Repair review: Equations"] && rv["Repair review: Fractions"] < rv["Repair review: Equations"]);
  assert.match(r.untested, /Your trouble with Word problems probably comes from Units/);
  assert.ok(r.uExtra > 0);
  assert.ok(r.strongKeeps);
  assert.equal(r.mock.kind, "mock");
  assert.match(r.mock.detail, /Below plan: Fractions 30%, Equations 20%\..*Your trouble with Equations probably comes from Fractions — reviewing Fractions first\./);
  assert.deepEqual([r.mock.bDelta, r.mock.aDelta], [90, 60], "the prerequisite gets its own repair once, not twice");
  assert.deepEqual([r.mock.bDue, r.mock.aDue], [r.t1, r.t2]);
  assert.ok(r.order, "prerequisites are learned first");
});

test("judges mock results by learning progress and estimates hours to mastery", async () => {
  const r = await page.evaluate(() => {
    newExam(); const e = examById(selExam); e.subject = "Physics"; e.target = 80;
    const H = mkTopic("Half learned", 3, 4), F = mkTopic("Fully learned", 3, 4);
    e.topics.push(H, F);
    const learned = (t, min) => S.blocks.push({ id: uid(), examId: e.id, topicId: t.id, type: "learn", status: "done", date: today(), start: "06:00", minutes: min, label: "Learn: " + t.name });
    learned(H, 120); learned(F, 240);
    commit();
    const mb = { id: uid(), examId: e.id, type: "mock", status: "planned", date: today(), start: "07:00", minutes: 90, label: "Mock exam" };
    S.blocks.push(mb);
    // 35% is far below the target (80%) but on track for a topic that is half learned (expected 40%)
    const m = applyMockResult(mb, [{ label: "Task 1", topicId: H.id, max: 20, got: 7 }, { label: "Task 2", topicId: F.id, max: 20, got: 7 }]);
    const out = { detail: m.detail, hExtra: H.extraMin, fExtra: F.extraMin, hDue: H.reviewDue };
    // fully learned, quizzed at 40%: 60% of 4 h is missing → 2.5 h (rounded to half hours)
    F.mastery = 40; F.extraMin = 0;
    out.hours = pointsTable(e).rows.find(x => x.t.id === F.id).hours;
    S.exams = S.exams.filter(x => x !== e); S.blocks = S.blocks.filter(b => b.examId !== e.id); selExam = null; commit();
    return out;
  });
  assert.match(r.detail, /Below plan: Fully learned 35%/);
  assert.match(r.detail, /Not learned yet: Half learned 35%\. This still has its learning time in the plan/, "compared with target × progress, not the full target");
  assert.doesNotMatch(r.detail, /On track/, "a low score is not listed as on track");
  assert.equal(r.hExtra, 0, "no repair time on top of the learning time still planned");
  assert.ok(r.fExtra > 0);
  assert.equal(r.hDue, null);
  assert.equal(r.hours, 2.5);
});

test("Teach the AI / oral results get the root-cause repair and stay out of the method comparison", async () => {
  const r = await page.evaluate(() => {
    newExam(); const e = examById(selExam); e.subject = "Merge check";
    const B = mkTopic("Basics", 3, 2), A = mkTopic("Advanced", 3, 2), C = mkTopic("Lighter", 3, 2);
    e.topics.push(B, A, C); A.prereqs = [B.id];
    B.mastery = 40; B.quizzes = [{ date: today(), score: 40 }];
    A.method = "explain"; C.method = "explain"; A.learnedOn = today(); C.learnedOn = today();
    for (const t of [A, C]) S.blocks.push({ id: uid(), examId: e.id, topicId: t.id, type: "learn", status: "done", date: today(), start: "06:00", minutes: 120, label: "Learn: " + t.name, ...(t === C ? { light: true } : {}) });
    commit();
    const methods0 = JSON.stringify(fingerprint().methods), n0 = S.fp.quizLog.length;
    logQuiz(e, A, 35, "teach"); const q = applyQuizResult(e, A, 35, ["limits"], "teach");
    logQuiz(e, C, 95, "oral"); applyQuizResult(e, C, 95, [], "oral");
    const out = { detail: q.detail, title: q.title, via: q.via, quiz: A.quizzes[A.quizzes.length - 1], bExtra: B.extraMin, bDue: B.reviewDue, aDue: A.reviewDue,
      t1: addDays(today(), 1), t2: addDays(today(), 2), kinds: S.fp.quizLog.slice(n0).map(x => [x.kind, x.light]), sameMethods: JSON.stringify(fingerprint().methods) === methods0 };
    S.fp.quizLog.splice(n0);
    S.exams = S.exams.filter(x => x !== e); S.blocks = S.blocks.filter(b => b.examId !== e.id); selExam = null; commit();
    return out;
  });
  assert.match(r.detail, /Your trouble with Advanced probably comes from Basics — reviewing Basics first\./);
  assert.match(r.title, /· Teach the AI$/);
  assert.equal(r.via, "teach");
  assert.deepEqual([r.quiz.score, r.quiz.via], [35, "teach"], "src kept on the quiz entry");
  assert.ok(r.bExtra > 0, "repair time on the prerequisite");
  assert.deepEqual([r.bDue, r.aDue], [r.t1, r.t2]);
  assert.deepEqual(r.kinds, [["teach", false], ["oral", true]]);
  assert.ok(r.sameMethods, "teach/oral don't count for the method comparison (also on a Go lighter topic)");
});

// An exam of its own with one topic and one material, so these results don't change the other tests' exams.
async function studyBlockWithMaterial() {
  return page.evaluate(async () => {
    newExam(); const e = examById(selExam); e.subject = "Methods exam"; e.date = addDays(today(), 5);
    const id = uid(), text = "\n=== p. 1 ===\nHypothesis tests compare H0 and H1.\n=== p. 2 ===\nHypothesis tests can make a Type I error (rejecting a true H0) or a Type II error.";
    await putMaterial(id, { name: "notes.pdf", kind: "script", text });
    e.materials.push({ id, name: "notes.pdf", kind: "script", pages: 2, chars: text.length, truncated: false, empty: false });
    e.topics.push(mkTopic("Hypothesis tests", 4, 2, "H0, H1 and error types."));
    commit();
    const b = S.blocks.find(x => x.examId === e.id && x.type === "learn" && x.status === "planned");
    studyId = b.id; busy.noCheck[b.id] = true; go("study");
    return b.id;
  });
}

test("Teach the AI: the AI asks follow-up questions, finds gaps in the material and the score feeds the plan", async () => {
  const id = await studyBlockWithMaterial();
  const before = await page.evaluate(() => ({ methods: JSON.stringify(fingerprint().methods), log: S.fp.quizLog.length }));
  await page.click('#modes [data-act="m-start"][data-k="teach"]');
  await page.fill("#mode-text", "Too short.");
  await page.click('[data-act="m-send"]');
  assert.match(await page.textContent("#toast"), /Write a few sentences first/);
  upstream.prompts = [];
  await page.fill("#mode-text", "A hypothesis test starts with H0, the default claim, and H1. We look at the data and decide whether to reject H0.");
  await page.click('[data-act="m-send"]');
  await page.waitForSelector("text=The AI asks");
  assert.match(upstream.prompts[0], /Feynman method/);
  assert.match(upstream.prompts[0], /\[notes\.pdf p\. 2\]\nHypothesis tests can make a Type I error/, "grounded in the topic's material");
  assert.ok(upstream.prompts[0].length < 40000, "prompt stays within the chunk budget");
  const modes = await page.innerHTML("#modes");
  assert.ok(modes.includes("So H0 is the &lt;b&gt;default&lt;/b&gt;?"), "the AI's reply is escaped");
  assert.match(await page.textContent("#modes"), /Gaps and mix-ups[\s\S]*Type I and Type II errors \(notes\.pdf p\. 2\)[\s\S]*No mention of p-values/);
  assert.equal(await page.locator("#modes ol.wsteps li").count(), 2, "at most two follow-up questions");
  assert.equal(await page.evaluate(() => SM[studyTopic].phase), "feedback", "nothing saved before the questions are answered or skipped");
  await page.fill("#mode-text", "A Type I error is rejecting H0 although it is true. Alpha is chosen before the test, often 5 %.");
  await page.click('[data-act="m-send"]');
  await page.waitForSelector("#mode-result");
  assert.match(upstream.prompts[1], /The student's answers:[\s\S]*Alpha is chosen/);
  const r = await page.evaluate(id => {
    const e = examById(selExam), t = e.topics[0], q = S.fp.quizLog[S.fp.quizLog.length - 1];
    return { score: SM[studyTopic].score, page: view === "study" && S.blocks.some(b => b.id === studyId && b.topicId === t.id) && !!document.querySelector("#mode-result"), mastery: t.mastery, quiz: t.quizzes[t.quizzes.length - 1], kind: q.kind, log: S.log[0], methods: JSON.stringify(fingerprint().methods), n: S.fp.quizLog.length };
  }, id);
  assert.equal(r.score, 80);
  assert.equal(r.page, true, "the Study page stays on the topic after the plan is rebuilt");
  assert.equal(r.mastery, 80);
  assert.deepEqual([r.quiz.score, r.quiz.via], [80, "teach"]);
  assert.equal(r.kind, "teach");
  assert.equal(r.n, before.log + 1);
  assert.equal(r.methods, before.methods, "the study-method comparison is not changed");
  assert.equal(r.log.kind, "quiz");
  assert.match(r.log.title, /Hypothesis tests: 80% \(expected \d+%\) · Teach the AI/);
  assert.match(await page.textContent("#mode-result"), /80%[\s\S]*What the coach changed/);
});

test("Oral exam practice: adapts questions, keeps the transcript when the AI fails, grades on the Austrian scale", async () => {
  const id = await studyBlockWithMaterial();
  // without the Web Speech API there is no mic button, typing works
  await page.evaluate(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  upstream.prompts = [];
  await page.click('#modes [data-act="m-start"][data-k="oral"]');
  await page.waitForSelector("text=Hello. What is a null hypothesis?");
  assert.equal(await page.locator('[data-act="m-mic"]').count(), 0, "no mic button without speech support");
  await page.fill("#mode-text", "The default <claim> we test against");
  await page.click('[data-act="m-send"]');
  await page.waitForSelector("text=Question 2:");
  assert.match(upstream.prompts[1], /EXAMINER: Hello\. What is a null hypothesis\?\n\nSTUDENT: The default <claim> we test against/, "the whole exam so far goes to the AI");
  assert.ok((await page.innerHTML("#mode-chat")).includes("The default &lt;claim&gt; we test against"), "answers are escaped");
  assert.match(await page.textContent("#modes"), /Question 2:.*you said "The default <claim> we test against"/, "the follow-up adapts to the answer");

  // the AI fails mid-conversation: the transcript stays and the answer can be sent again
  upstream.fail = 500;
  await page.fill("#mode-text", "Rejecting a true H0");
  await page.click('[data-act="m-send"]');
  await page.waitForSelector("#modes .alert.bad");
  upstream.fail = null;
  const err = await page.textContent("#modes");
  assert.match(err, /Something went wrong talking to the AI[\s\S]*Nothing is lost/);
  assert.match(err, /Details: 500 server error: Simulated failure/, "neutral error copy with the technical detail");
  assert.doesNotMatch(err, /gemini|anthropic|claude|netlify|api key/i, "no product or hosting names");
  assert.match(err, /Hello\. What is a null hypothesis\?[\s\S]*Question 2:[\s\S]*Rejecting a true H0/);
  await page.click('[data-act="m-retry"]');
  await page.waitForSelector("text=Question 3:");
  assert.match(await page.textContent("#modes"), /you said "Rejecting a true H0"/);

  // speech input, when the browser has it, adds the recognised words to the answer box
  await page.evaluate(() => {
    window.SpeechRecognition = class { start() { setTimeout(() => this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: "keeping a false H0" }], { isFinal: true })] }), 20); } stop() { this.onend && this.onend(); } };
    render();
  });
  await page.fill("#mode-text", "A Type II error is");
  await page.click('[data-act="m-mic"]');
  await page.waitForFunction(() => document.querySelector("#mode-text").value === "A Type II error is keeping a false H0");
  assert.equal(await page.textContent('[data-act="m-mic"]'), "Stop listening");
  await page.click('[data-act="m-send"]');
  await page.waitForSelector("#mode-result");
  await page.evaluate(() => { delete window.SpeechRecognition; render(); });
  assert.match(upstream.prompts[upstream.prompts.length - 1], /STUDENT: A Type II error is keeping a false H0/);
  assert.match(upstream.prompts[upstream.prompts.length - 1], /End the exam now|end the exam/);
  const res = await page.textContent("#mode-result");
  assert.match(res, /Grade estimate\s*3\s*Befriedigend · 70%/);
  assert.match(res, /Solid basics[\s\S]*Defines H0 clearly[\s\S]*Type II error/);
  const r = await page.evaluate(() => { const t = examById(selExam).topics[0]; return { quiz: t.quizzes[t.quizzes.length - 1], kind: S.fp.quizLog[S.fp.quizLog.length - 1].kind, log: S.log[0], weak: t.weakConcepts }; });
  assert.deepEqual([r.quiz.score, r.quiz.via, r.kind], [70, "oral", "oral"]);
  assert.match(r.log.title, /Hypothesis tests: 70% .* · oral exam practice/);
  assert.ok(r.weak.includes("Type II error"), "missed concepts feed the next quizzes");
  // done: the panel offers the modes again
  await page.click('#mode-result [data-act="m-close"]');
  assert.equal(await page.locator('#modes [data-act="m-start"]').count(), 2);
  await page.evaluate(() => go("dashboard"));
});

test("fills defaults for new fields in older saved states and backups", async () => {
  const r = await page.evaluate(() => {
    const keep = S;
    S = { exams: [{ id: "x", subject: "Old", date: "2026-01-01", target: 80, materials: [], review: { grade: "ok", gradeNum: "7", stats: {} },
        topics: [{ id: "a", name: "A", prereqs: ["b"] }, { id: "b", name: "B", prereqs: ["a", "b", "zz"] }, { id: "c", name: "C" }] }],
      blocks: [{ id: "b1", examId: "x", type: "mock", status: "done", date: "2025-12-30", minutes: 90, mock: { at: "x" } }],
      fp: { quizLog: [] }, archive: [{ name: "Old semester", exams: [{ subject: "A", date: "2025-06-01", review: { grade: "2", gradeNum: 2 } }] }] };
    normalize();
    const out = { mode: S.exams[0].mode, pass: S.exams[0].passPct, oldTasks: S.exams[0].oldTasks, gradeNum: S.exams[0].review.gradeNum, mock: "mock" in S.blocks[0],
      energy: S.fp.energy, realismPast: S.fp.realismPast, prereqs: S.exams[0].topics.map(t => t.prereqs), arch: S.archive[0].exams[0], html: statsList(S.archive[0].exams[0].stats, S.archive[0].exams[0].review) };
    // numbers and status values from a crafted backup are coerced or escaped
    S.blocks = [{ id: '"><img id=pwn1>', examId: "x", type: "<img id=pwn2>", status: "<img id=pwn3>", date: "2026-01-02", start: "<b>9</b>", minutes: "<img id=pwn4>", label: "L", focusMin: "<i>" },
      { id: "m", examId: "x", type: "mock", status: "done", date: "2026-01-02", minutes: 90, mock: { at: "x", tasks: [{ label: "<b>", got: "<img>", max: "x" }, 5], fx: "bad" } }];
    normalize();
    out.blocks = S.blocks.map(b => [b.type, b.status, b.minutes]);
    out.fx = "fx" in S.blocks[1].mock;
    out.tasks = S.blocks[1].mock.tasks;
    out.rows = S.blocks.map(b => blockRow(b, { showDate: true })).join("") + blockRow({ id: "z", examId: "x", type: "<u>", status: "<s>", date: "2026-01-02", start: "9", minutes: "<em>", label: "z" });
    out.stats = statsList({ nQuiz: "<b id=a>", first: "<i>", last: 3, readiness: "<b id=x>", plannedMin: "<b>", doneMin: 5, best: { m: "constructor", mean: "<u>" }, mock: { got: "<b>", max: "<i>", pct: "<s>" } }, { gradeNum: "<b>", grade: "<i>x</i>" });
    S = keep; normalize();
    return out;
  });
  assert.deepEqual(r.blocks, [["review", "planned", 0], ["mock", "done", 90]]);
  assert.equal(r.fx, false);
  assert.deepEqual(r.tasks.map(x => [x.label, x.got, x.max]), [["<b>", 0, 0]]);
  for (const html of [r.rows, r.stats]) {
    assert.doesNotMatch(html, /<(img|b id|i>|u>|s>|em>)/, "no markup from saved values");
    assert.doesNotMatch(html, /NaN|undefined|\[object/);
  }
  assert.match(r.stats, /&lt;i&gt;x&lt;\/i&gt;/, "the result text is escaped");
  assert.deepEqual([r.mode, r.pass, r.oldTasks, r.gradeNum, r.mock, r.energy, r.realismPast], ["top", 50, [], null, false, [], null]);
  assert.deepEqual([r.arch.topics, r.arch.oldTasks, r.arch.mocks, r.arch.review.gradeNum], [[], [], [], 2]);
  assert.deepEqual(r.prereqs, [[], ["a"], []], "missing links default to [], self-links, unknown topics and loops are dropped");
  assert.match(r.html, /2 \(Gut\)/);
});

test("reviews a finished exam, starts a new semester and keeps the profile through a backup", async () => {
  const subject = await page.evaluate(() => {
    const e = S.exams[0], t = e.topics[0];
    const b = S.blocks.find(x => x.examId === e.id && x.status === "planned");
    b.date = addDays(today(), -3); b.status = "done";
    t.quizzes.push({ date: today(), score: 90 }, { date: today(), score: 95 });
    // a block from before the exam that was never marked: no longer asked about once the exam is over
    S.blocks.push({ id: "open-old", examId: e.id, topicId: t.id, type: "learn", status: "planned", date: addDays(today(), -2), start: "17:00", minutes: 30, label: "Learn: never marked" });
    e.date = addDays(today(), -1); commit(); go("dashboard");
    return e.subject;
  });
  const main = await page.textContent("main");
  assert.doesNotMatch(main, /Did you do these\?|never marked/, "blocks of a finished exam aren't asked about");
  assert.ok(main.includes(`How did ${subject} go?`));
  assert.match(main, /Mock exam27\/50 points \(54%\)[\s\S]*Study time[\s\S]*done of[\s\S]*Quiz trend[\s\S]*Best method/);
  const eid = await page.evaluate(() => S.exams[0].id);
  // nothing entered: not saved
  await page.click(`[data-act="rv-save"][data-exam="${eid}"]`);
  assert.equal(await page.evaluate(() => S.exams[0].review), undefined);
  // a numeric grade alone is enough
  await page.selectOption(`#rv-gradeNum-${eid}`, "2");
  await page.click(`[data-act="rv-save"][data-exam="${eid}"]`);
  assert.deepEqual(await page.evaluate(() => [S.exams[0].review.gradeNum, S.exams[0].review.grade]), [2, ""]);
  assert.match(await page.textContent("main"), /Grade2 \(Gut\) · plan predicted \d+% readiness/);
  await page.click(`[data-act="rv-edit"][data-exam="${eid}"]`);
  assert.equal(await page.inputValue(`#rv-gradeNum-${eid}`), "2");
  await page.fill(`#rv-grade-${eid}`, "2 (good)");
  await page.fill(`#rv-helped-${eid}`, "The mock exam <b>and</b> flashcards");
  await page.fill(`#rv-didnt-${eid}`, "Starting too late");
  await page.click(`[data-act="rv-save"][data-exam="${eid}"]`);
  const rv = await page.evaluate(() => S.exams[0].review);
  assert.equal(rv.grade, "2 (good)");
  assert.equal(rv.gradeNum, 2);
  assert.deepEqual(rv.stats.mock, { got: 27, max: 50, pct: 54, date: rv.stats.mock.date });
  assert.equal(rv.stats.nQuiz, 3, "mock results are not counted as quizzes");
  assert.match(await page.textContent("main"), /Grade2 \(Gut\) · plan predicted \d+% readiness\s*Result2 \(good\)\s*Mock exam27\/50 points/);
  assert.equal(rv.stats.nQuiz >= 3, true);
  assert.ok(rv.stats.plannedMin >= rv.stats.doneMin && rv.stats.doneMin > 0);
  assert.ok((await page.innerHTML("main")).includes("The mock exam &lt;b&gt;and&lt;/b&gt; flashcards"), "reflection is escaped");

  const before = await page.evaluate(() => ({ exams: S.exams.length, quizLog: S.fp.quizLog.length, sessions: S.fp.sessions.length, energy: S.fp.energy.length, realism: fingerprint().realism.n }));
  await page.click('[data-act="new-semester"]');
  assert.match(await page.textContent('[data-act="new-semester"]'), /Click again to archive 1 exam/);
  await page.click('[data-act="new-semester"]');
  const after = await page.evaluate(id => ({ exams: S.exams.length, blocks: S.blocks.filter(b => b.examId === id).length, archive: S.archive.length, grade: S.archive[0].exams[0].review.grade,
    topics: S.archive[0].exams[0].topics.length, quizLog: S.fp.quizLog.length, sessions: S.fp.sessions.length, energy: S.fp.energy.length, realism: fingerprint().realism.n }), eid);
  assert.deepEqual(after, { exams: before.exams - 1, blocks: 0, archive: 1, grade: "2 (good)", topics: after.topics, quizLog: before.quizLog, sessions: before.sessions, energy: before.energy, realism: before.realism });
  assert.ok(after.topics >= 2);
  // old-exam tasks and mock results are archived with topic links intact
  const arch = () => { const x = S.archive[0].exams[0], name = id => (x.topics.find(t => t.id === id) || {}).name || null;
    return { gradeNum: x.review.gradeNum, mock: x.stats.mock && x.stats.mock.pct, oldTasks: x.oldTasks.map(o => [o.label, name(o.topicId), o.points]),
      mocks: x.mocks.map(m => m.tasks.map(o => [o.label, name(o.topicId), o.got, o.max])), mode: x.mode }; };
  const archived = await page.evaluate(`(${arch})()`);
  assert.deepEqual(archived, { gradeNum: 2, mock: 54, mode: "top", oldTasks: [["Task 1", "Hypothesis tests", 30], ["Task 2", "Linear regression", 20]],
    mocks: [[["Task 1", "Hypothesis tests", 9, 30], ["Task 2", "Linear regression", 18, 20]]] });
  await page.evaluate(() => go("you"));
  assert.match(await page.textContent("main"), /Past exams[\s\S]*2 \(Gut\)[\s\S]*2 \(good\)[\s\S]*Mock exam27\/50[\s\S]*Starting too late/);

  await page.waitForTimeout(1200);
  const [bk] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => exportBackup())]);
  const backup = JSON.parse(fs.readFileSync(await bk.path(), "utf8"));
  const fresh = await browser.newContext();
  await serve(fresh);
  const p2 = await open(fresh);
  await p2.evaluate(async d => { busy.restore = d; await restoreBackup(); }, backup);
  const restored = await p2.evaluate(() => ({ exams: S.exams.length, archive: S.archive.length, grade: S.archive[0].exams[0].review.grade, quizLog: S.fp.quizLog.length, energy: S.fp.energy.length, realismPast: S.fp.realismPast }));
  assert.deepEqual(await p2.evaluate(`(${arch})()`), archived, "archived tasks and mock results survive the backup");
  assert.deepEqual(restored, { exams: after.exams, archive: 1, grade: "2 (good)", quizLog: before.quizLog, energy: before.energy, realismPast: backup.state.fp.realismPast });
  assert.ok(backup.state.fp.realismPast.total >= 1);
  await fresh.close();
});

test("shows what went wrong when the AI fails", async () => {
  upstream.fail = 500;
  const msg = await page.evaluate(async () => { try { await AI.json("x"); return "no error"; } catch (e) { return aiError(e); } });
  upstream.fail = null;
  assert.match(msg, /Something went wrong talking to the AI\. Try again\. Details: 500 server error: Simulated failure/);
  const texts = await page.evaluate(() => [...["not_configured", "bad_key", "model_unavailable", "forbidden"].map(code => aiError({ code })),
    aiError({ code: "upstream_error", detail: "Gemini 503: models/gemini-3.8-flash at generativelanguage.googleapis.com is overloaded" })]);
  for (const t of texts) assert.doesNotMatch(t, /gemini|google|anthropic|claude|netlify|readme|api_key/i, t);
  assert.match(texts[4], /Details: .*503.*overloaded/, "technical detail is kept");
  upstream.fail = 429;
  const limit = await page.evaluate(async () => { try { await AI.json("x"); return "no error"; } catch (e) { return aiError(e); } });
  upstream.fail = null;
  assert.match(limit, /usage limit/);
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
  delete process.env.GEMINI_API_KEY;
  await page.reload();
  await page.waitForFunction(() => aiState !== "checking");
  assert.equal(await page.evaluate(() => aiState), "off");
  process.env.GEMINI_API_KEY = "test-key";
});

test("works on a 375 px phone screen", async () => {
  const phone = await browser.newContext({ viewport: { width: 375, height: 740 } });
  await serve(phone);
  const p = await open(phone);
  await p.click('[data-act="example"]');
  // every section is reachable: the tabs get their own row and none is cut off
  const nav = await p.evaluate(() => [...document.querySelectorAll("#nav button")].map(b => { const r = b.getBoundingClientRect(); return [r.left >= 0 && r.right <= innerWidth, r.width > 30]; }));
  assert.equal(nav.length, 6);
  assert.ok(nav.every(([inside, wide]) => inside && wide), JSON.stringify(nav));
  await p.click('#nav [data-view="history"]');
  assert.equal(await p.evaluate(() => view), "history");
  // the open focus timer doesn't cover the end of the page
  await p.evaluate(() => go("dashboard"));
  await p.click('#timer [data-t="open"]');
  const pad = await p.evaluate(() => { const card = $("#timer").getBoundingClientRect(), m = parseFloat(getComputedStyle($("#main")).paddingBottom); return { card: card.height, pad: m }; });
  assert.ok(pad.pad >= pad.card, `main padding ${pad.pad} >= timer ${pad.card}`);
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const covered = await p.evaluate(() => { const last = [...document.querySelectorAll("main > *")].pop().getBoundingClientRect(); return last.bottom > $("#timer").getBoundingClientRect().top; });
  assert.equal(covered, false, "the last section ends above the timer");
  await p.click('#timer [data-t="min"]');
  // the mock exam form fits the screen: rows become cards, nothing scrolls sideways
  await p.evaluate(() => openMock(S.blocks.find(b => b.type === "mock")));
  const fit = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, table: $("#mk-table").scrollWidth, wrap: $("#mk-table").parentElement.clientWidth,
    inputs: [...document.querySelectorAll("#mk-table input, #mk-table select")].every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width >= 60; }) }));
  assert.ok(fit.doc <= 375 && fit.table <= fit.wrap, JSON.stringify(fit));
  assert.ok(fit.inputs, "every field is fully on screen");
  await p.fill("#mk-got-0", "1");
  assert.match(await p.textContent("#mk-total"), /^1 of/);
  await phone.close();
});

test("makes no requests to other servers and has no errors", () => {
  assert.ok(upstream.calls >= 4, "the AI backend was called");
  assert.ok(upstream.models.every(m => m === "gemini-3.8-flash"), "uses the default Gemini model");
  assert.deepEqual(problems, []);
});
