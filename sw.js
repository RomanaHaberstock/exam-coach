// Exam Coach service worker: the app opens without a connection and can be installed.
//
// Same origin only (no other hosts exist under the CSP). Strategy: network first for every page
// file, so an online visit always gets the files of the latest deploy; the copy in the cache is
// only used when the network fails (offline). The AI backend (/api/…) is never cached.
// The app shell is stored when the worker installs; other same-origin files (e.g. the pdf.js
// worker, 1.1 MB) are stored the first time they are loaded.
//
// Updates: change VERSION whenever this file or the SHELL list changes (a test checks every
// SHELL file exists). A new worker installs next to the old one and waits; the page shows
// "A new version of Exam Coach is ready — Reload", which tells it to take over (skipWaiting) and
// reloads. Old caches are deleted when the new worker activates.
const VERSION = "2026-11-17.1";
const CACHE = "exam-coach-" + VERSION;
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "assets/app.js",
  "assets/demo.js",
  "assets/styles.css",
  "assets/fonts.css",
  "assets/icon.svg",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/icons/maskable-512.png",
  "assets/icons/apple-touch-icon.png",
  "assets/vendor/pdfjs/pdf.min.js",
  "assets/fonts/bricolage-grotesque-latin-500-normal.woff2",
  "assets/fonts/bricolage-grotesque-latin-700-normal.woff2",
  "assets/fonts/bricolage-grotesque-latin-ext-500-normal.woff2",
  "assets/fonts/bricolage-grotesque-latin-ext-700-normal.woff2",
  "assets/fonts/ibm-plex-mono-latin-400-normal.woff2",
  "assets/fonts/ibm-plex-mono-latin-500-normal.woff2",
  "assets/fonts/ibm-plex-mono-latin-ext-400-normal.woff2",
  "assets/fonts/ibm-plex-mono-latin-ext-500-normal.woff2",
  "assets/fonts/ibm-plex-sans-latin-400-normal.woff2",
  "assets/fonts/ibm-plex-sans-latin-500-normal.woff2",
  "assets/fonts/ibm-plex-sans-latin-600-normal.woff2",
  "assets/fonts/ibm-plex-sans-latin-ext-400-normal.woff2",
  "assets/fonts/ibm-plex-sans-latin-ext-500-normal.woff2",
  "assets/fonts/ibm-plex-sans-latin-ext-600-normal.woff2",
];

self.addEventListener("install", ev => {
  // cache: "reload" skips the browser's HTTP cache, so the shell is the deployed one
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))));
});

self.addEventListener("activate", ev => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("exam-coach-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", ev => { if (ev.data && ev.data.type === "skip-waiting") self.skipWaiting(); });

self.addEventListener("fetch", ev => {
  const req = ev.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  ev.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        ev.waitUntil(caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}));
      }
      return res;
    } catch (err) {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      // any page address (e.g. /#plan, /?x) opens the app
      if (req.mode === "navigate") { const page = await cache.match("index.html") || await cache.match("./"); if (page) return page; }
      throw err;
    }
  })());
});
