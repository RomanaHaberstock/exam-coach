// Tests for the offline app: service worker (sw.js), manifest and update rollout.
// Service workers only run on https or localhost, so this file serves the repository from a real
// HTTP server on 127.0.0.1 (the other end-to-end tests use a made-up http host, where the page
// doesn't register a worker at all).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOML = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
const CSP = TOML.match(/Content-Security-Policy = "([^"]+)"/)[1];
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const SW = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
let swBody = SW, appBody = null, server, origin, browser;
const problems = [];

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/ai") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":false}'); }
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "content-security-policy": CSP, "cache-control": "no-cache" });
    res.end(rel === "sw.js" ? swBody : rel === "assets/app.js" && appBody ? appBody : fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

const shell = () => JSON.parse("[" + SW.match(/const SHELL = \[([\s\S]*?)\];/)[1].replace(/,\s*$/, "") + "]");

test("every app shell file exists, and the CSP allows the worker and the manifest", () => {
  for (const f of shell()) if (f !== "./") assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is in sw.js SHELL but doesn't exist (the worker would fail to install)`);
  assert.match(CSP, /worker-src 'self'/);
  assert.match(CSP, /manifest-src 'self'/);
  assert.match(TOML, /for = "\/sw\.js"[\s\S]*?Cache-Control = "no-cache"/, "sw.js is never served from an old copy");
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.webmanifest"), "utf8"));
  assert.equal(m.display, "standalone");
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(ROOT, i.src)), i.src);
  assert.ok(m.icons.some(i => i.sizes === "192x192") && m.icons.some(i => i.sizes === "512x512") && m.icons.some(i => i.purpose === "maskable"), "installable icons");
  assert.ok(shell().includes("manifest.webmanifest") && shell().includes("assets/app.js") && shell().includes("index.html"));
  // every script, stylesheet and icon the page loads is in the shell (e.g. assets/demo.js), so nothing is missing offline
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  for (const [, f] of html.matchAll(/(?:src|href)="((?:assets\/)[^"#?]+)"/g)) assert.ok(shell().includes(f), `${f} is loaded by index.html but missing from sw.js SHELL`);
});

test("installs, opens offline, and rolls out a new version with one Reload", async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  p.on("pageerror", e => problems.push("page error: " + e.message));
  p.on("console", m => { if (m.type() === "error" && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) problems.push("console: " + m.text()); });
  await p.goto(origin + "/");
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload();
  await p.waitForFunction(() => !!navigator.serviceWorker.controller);
  const keys = await p.evaluate(() => caches.keys());
  assert.deepEqual(keys, ["exam-coach-" + SW.match(/const VERSION = "([^"]+)"/)[1]]);
  assert.equal(await p.evaluate(async () => (await caches.open((await caches.keys())[0])).keys().then(k => k.length)) >= shell().length, true, "the shell is cached");
  assert.ok(await p.evaluate(() => fetch("/manifest.webmanifest").then(r => r.json()).then(m => m.name === "Exam Coach")));

  // offline: the app opens from the cache, also under another address of the page
  await ctx.setOffline(true);
  for (const u of ["/", "/#plan", "/?from=homescreen"]) {
    await p.goto(origin + u);
    await p.waitForFunction(() => typeof aiState !== "undefined" && aiState !== "checking");
    assert.match(await p.textContent("main"), /Try it with example exams|Week by week|Do this now/, `opens offline at ${u}`);
  }
  assert.equal(await p.evaluate(() => aiState), "off", "no AI offline");
  // the example with its history, built-in questions and How it works works offline (demo.js is cached)
  await p.click('main [data-act="demo"]');
  await p.waitForSelector("#tour");
  await p.keyboard.press("Escape");
  assert.equal(await p.evaluate(() => S.exams.filter(e => e.example).length), 2);
  await p.evaluate(() => go("how"));
  assert.equal(await p.locator("#how-loop").count(), 1, "How it works offline");
  await ctx.setOffline(false);

  // a new deploy: changed worker → it waits, the page offers Reload, Reload switches over once
  await p.goto(origin + "/");
  await p.waitForFunction(() => !!navigator.serviceWorker.controller);
  swBody = SW.replace(/const VERSION = "[^"]+"/, 'const VERSION = "test-next"');
  await p.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
  await p.waitForSelector("#sw-reload", { timeout: 15000 });
  assert.match(await p.textContent("#toast"), /A new version of Exam Coach is ready/);
  await p.waitForFunction(() => /A new version of Exam Coach is ready/.test($("#live").textContent), null, { timeout: 3000 });
  // a later toast replaces the offer only for a while; then the offer comes back
  await p.evaluate(() => toast("Saved."));
  assert.equal(await p.locator("#sw-reload").count(), 0);
  await p.click("#toast");
  await p.waitForSelector("#sw-reload", { timeout: 3000 });
  const reloaded = p.waitForEvent("load");
  await p.click("#sw-reload");
  await reloaded;
  await p.waitForFunction(async () => (await caches.keys()).join() === "exam-coach-test-next", null, { timeout: 15000 });

  // ?nosw removes the worker (for debugging)
  await p.goto(origin + "/?nosw");
  await p.waitForFunction(async () => !(await navigator.serviceWorker.getRegistrations()).length, null, { timeout: 15000 });
  swBody = SW;
  await ctx.close();
  assert.deepEqual(problems, []);
});

test("the emergency off switch (docs/sw-kill-switch.js) removes the worker and its caches", async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  p.on("pageerror", e => problems.push("page error: " + e.message));
  await p.goto(origin + "/");
  await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  await p.waitForFunction(async () => (await caches.keys()).length > 0, null, { timeout: 15000 });
  // the deploy: sw.js = the kill switch, registerSW() removed from boot()
  const APP = fs.readFileSync(path.join(ROOT, "assets/app.js"), "utf8");
  assert.match(APP, /\n  registerSW\(\);\n\}/);
  appBody = APP.replace(/\n  registerSW\(\);\n\}/, "\n}");
  swBody = fs.readFileSync(path.join(ROOT, "docs/sw-kill-switch.js"), "utf8");
  try {
    const reloaded = p.waitForEvent("load", { timeout: 15000 });
    await p.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
    await reloaded; // the switch reloads open tabs
    await p.waitForFunction(async () => !(await navigator.serviceWorker.getRegistrations()).length && !(await caches.keys()).length && !navigator.serviceWorker.controller, null, { timeout: 15000 });
    await p.waitForFunction(() => typeof S === "object" && !!document.querySelector("#main h1, #main h2"));
    await p.reload();
    await p.waitForTimeout(500);
    assert.equal(await p.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0, "stays off");
  } finally { swBody = SW; appBody = null; }
  await ctx.close();
  assert.deepEqual(problems, []);
});
