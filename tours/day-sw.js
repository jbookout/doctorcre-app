// Cache application code only. Never cache session/API responses, tour records,
// provider tiles or audio; account-scoped drafts stay in the page's IndexedDB.
importScripts("/tours/day-shell.generated.js");
const { cache: CACHE, files: FILES } = self.TOUR_DAY_SHELL;
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil((async () => {
  // eslint-disable-next-line no-restricted-syntax -- Activation visits the finite cache-name snapshot once and deletes each obsolete tour shell only once.
  for (const name of await caches.keys()) {
    if (name.startsWith("doctorcre-tour-day-shell-") && name !== CACHE) await caches.delete(name);
  }
  await self.clients.claim();
})()));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !FILES.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(url.pathname);
    if (saved) return saved;
    return fetch(event.request, { signal: AbortSignal.timeout(3_000) }).catch(() => new Response("Offline app unavailable", { status: 503 }));
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'doctorcre-prepare-tour-shell') event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      const missing = (await Promise.all(FILES.map(async path => await cache.match(path) ? null : path))).filter(Boolean);
      if (missing.length) await cache.addAll(missing);
      event.ports[0]?.postMessage({ ready: true });
    } catch { event.ports[0]?.postMessage({ ready: false }); }
  })());
  if (event.data?.type === 'doctorcre-session-revoked') event.waitUntil(caches.keys().then(names => Promise.all(names.map(name => caches.delete(name)))));
});
