// Kill-switch service worker.
//
// The app no longer uses a service worker, but earlier deploys registered one that is
// still installed in some browsers. That stale worker intercepts requests for the new
// hashed code-split chunks (e.g. DiskHistoryChart-*.js) and fails, and it could never
// update itself because /sw.js now falls through to index.html (invalid as a SW script).
//
// This valid script replaces any installed worker, wipes its caches, unregisters
// itself, and reloads open tabs so they fetch straight from the network. It registers
// no fetch handler, so it never intercepts a request.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.navigate(client.url);
  })());
});
