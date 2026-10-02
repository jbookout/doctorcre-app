// Cache application code only. Never cache session/API responses, tour records,
// provider tiles or audio; account-scoped drafts stay in the page's IndexedDB.
const CACHE = "doctorcre-tour-day-shell-v1";
const FILES = ["/tours/day.html", "/tours/day.js", "/tours/day.css", "/tours/day-client.js", "/tours/day-store.js", "/tours/day-recorder.js", "/tours/planner-client.js", "/tours/itinerary-map.js", "/tours/vendor/tour-map-route-state.js", "/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs", "/tours/vendor/maplibre-gl-6.4.1/maplibre-gl-worker.mjs", "/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.css", "/css/app-shell.css", "/js/app-shell.js", "/js/offline-tour-session.js", "/js/auto-refresh.mjs", "/js/read-on-resume.mjs", "/js/shell.js", "/js/visual-system.js", "/js/boot-mode.js", "/js/doc-dock.js"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !FILES.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(async () => {
    const cache = await caches.open(CACHE);
    return await cache.match(url.pathname) || new Response("Offline", { status: 503 });
  }));
});
