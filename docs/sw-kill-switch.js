// Emergency off switch for the offline app. To use it:
// 1. Replace the contents of sw.js with this file (keep sw.js served: deleting it leaves the old
//    worker installed in every browser that has it).
// 2. Remove the registerSW() call from boot() in assets/app.js (otherwise each page load would
//    install this worker again and it would reload the page every time).
// 3. Commit both. On the next visit with a connection, the old worker sees the changed sw.js, this
//    one takes over at once, deletes every cache, unregisters itself and reloads open tabs, which
//    then load straight from the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", ev => ev.waitUntil((async () => { for (const k of await caches.keys()) await caches.delete(k); await self.registration.unregister(); for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url); })()));
