// Regenerates the README screenshots in docs/screenshots/ from the built-in example data.
// No AI is needed: the example has its own history and quiz questions.
// Run: node tests/make-screenshots.mjs   (not part of npm test)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
// A weekday morning, so "Do this now" has a block.
const WHEN = new Date("2026-11-18T10:00:00");

async function page(browser, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: "light" });
  await ctx.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/ai") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    const file = path.join(ROOT, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) });
  });
  const p = await ctx.newPage();
  await p.clock.install({ time: WHEN });
  await p.goto("http://exam-coach.test/");
  await p.waitForFunction(() => typeof aiState !== "undefined" && aiState !== "checking");
  await p.evaluate(() => loadDemo({ tour: false }));
  await p.evaluate(() => document.fonts.ready);
  return { ctx, p };
}
const shot = async (p, name, view, opts = {}) => {
  if (view) await p.evaluate(v => go(v), view);
  await p.waitForFunction(() => !/Saving/.test($("#savestate").textContent), null, { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(150);
  await p.screenshot({ path: path.join(OUT, name), ...opts });
  console.log("wrote", name);
};

const browser = await chromium.launch();
const { ctx, p } = await page(browser, { width: 1440, height: 900 });
await shot(p, "today.png", "dashboard");
await shot(p, "plan.png", "plan");
await shot(p, "plan-changes.png", "history");
await shot(p, "learning-profile.png", "you");
await shot(p, "how-it-works.png", "how");
// a quiz with the example questions, answered partly wrong, and what the coach changed
await p.evaluate(() => { const e = S.exams[0]; quiz = { examId: e.id, topicId: e.topics.find(t => t.name === "Probability basics").id, phase: "pick" }; go("quiz"); });
await p.click('[data-act="quiz-example"]');
for (const [i, j] of [[0, 1], [1, 0], [2, 1], [3, 0], [4, 1]]) await p.check(`#q${i}-${j}`);
await p.click('[data-act="submit"]');
await p.waitForSelector("text=What the coach changed");
await p.evaluate(() => window.scrollTo(0, 0));
await shot(p, "quiz-result.png");
// the tour on its first step
await p.evaluate(() => startTour());
await p.waitForTimeout(600);
await shot(p, "tour.png");
await ctx.close();
const phone = await page(browser, { width: 390, height: 844 });
await shot(phone.p, "phone.png", "dashboard");
await phone.ctx.close();
await browser.close();
