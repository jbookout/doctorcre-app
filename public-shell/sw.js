const SHELL_CACHE = 'dealroom-shell-v6';
const SHELL = ['/offline.html','/public-shell/session-ended.html','/public-shell/shell.css','/manifest.webmanifest','/icons/dealroom-192.png','/icons/dealroom-512.png'];
const staticAsset = path => SHELL.includes(path) || /^\/(?:js|css)\/.+\.(?:m?js|css)$/.test(path);
const cacheable = response => response.ok && !/\b(?:no-store|private)\b/i.test(response.headers.get('cache-control') || '');
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', event => event.waitUntil(caches.keys()
  .then(names => Promise.all(names.filter(name => name.startsWith('dealroom-shell-') && name !== SHELL_CACHE).map(name => caches.delete(name))))
  .then(() => self.clients.claim())));
self.addEventListener('message', event => {
  if (event.data?.type !== 'doctorcre-session-revoked') return;
  event.waitUntil(caches.keys().then(names => Promise.all(names.map(name => caches.delete(name)))));
});
async function networkOnly(request) {
  try { return await fetch(request); }
  catch {
    const path = new URL(request.url).pathname;
    if (request.mode === 'navigate' && !/^\/(?:auth|api)\//.test(path) && path !== '/mcp') return await caches.match('/offline.html') || new Response('Offline',{status:503});
    return new Response(JSON.stringify({error:'offline',state:'reconnecting',live:false}),{status:503,headers:{'content-type':'application/json','cache-control':'no-store'}}); }
}
async function shell(request) {
  try {
    const response = await fetch(request);
    if (cacheable(response)) await (await caches.open(SHELL_CACHE)).put(request,response.clone());
    return response;
  } catch { return await caches.match(request) || new Response('Offline',{status:503}); }
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Auth, APIs, MCP and unknown paths never consult CacheStorage. Only the
  // explicit static shell may be cached, regardless of HTTP success.
  if (event.request.method !== 'GET' || !staticAsset(url.pathname)) event.respondWith(networkOnly(event.request));
  else event.respondWith(shell(event.request));
});

function pushTarget(value) {
  if (!value || value.schema_version !== 'web-push.v1' || typeof value.event_id !== 'string' || !value.event_id || value.event_id.length > 512 || /[\u0000-\u001f\u007f]/.test(value.event_id)) return null;
  const path = `/inbox/card/${encodeURIComponent(value.event_id)}`;
  if (value.path !== path) return null;
  const url = new URL(path, self.location.origin);
  if (url.origin !== self.location.origin || url.pathname !== path || url.search || url.hash) return null;
  return { event_id: value.event_id, path };
}
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let target;
    try { target = pushTarget(event.data?.json()); } catch { return; }
    if (!target) return;
    await self.registration.showNotification('DoctorCRE needs your attention', {
      body: 'Open your Inbox to review the current card.',
      tag: `doctorcre:${target.event_id}`, data: target,
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = pushTarget({ ...event.notification.data, schema_version: 'web-push.v1' });
    if (!target) return;
    const url = new URL(target.path, self.location.origin).href;
    const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter(client => new URL(client.url).origin === self.location.origin);
    const window = windows.find(client => client.url === url) || windows.find(client => /^\/inbox(?:\/|$)/.test(new URL(client.url).pathname));
    if (window) { if (window.url !== url) await window.navigate(url); await window.focus(); }
    else await self.clients.openWindow(url);
  })());
});
