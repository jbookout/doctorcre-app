// Cache application code only. Never cache session/API responses, tour records,
// provider tiles or audio; account-scoped drafts stay in the page's IndexedDB.
importScripts("/tours/day-shell.generated.js");
const { cache: CACHE, files: FILES } = self.TOUR_DAY_SHELL;
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const name of await caches.keys()) {
    if (name.startsWith("doctorcre-tour-day-shell-") && name !== CACHE) await caches.delete(name);
  }
  await self.clients.claim();
})()));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !FILES.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(async () => {
    const cache = await caches.open(CACHE);
    return await cache.match(url.pathname) || new Response("Offline", { status: 503 });
  }));
});
