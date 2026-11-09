export {};

declare const self: ServiceWorkerGlobalScope;
type Operation = Record<string, unknown> & { deal: string };
type Share = {
  id: string;
  file: File;
  session: string;
  expires: number;
  keys: { reserve: string; finalize: string; abandon: string };
  operation: Operation | null;
  clientId?: string;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
const SHELL_CACHE = "dealroom-shell-v7";
const SHELL = [
  "/offline.html",
  "/public-shell/session-ended.html",
  "/public-shell/shell.css",
  "/manifest.webmanifest",
  "/icons/dealroom-192.png",
  "/icons/dealroom-512.png",
];
const staticAsset = (path: string) => SHELL.includes(path) || /^\/(?:js|css)\/.+\.(?:m?js|css)$/.test(path);
const cacheable = (response: Response) =>
  response.ok && !/\b(?:no-store|private)\b/i.test(response.headers.get("cache-control") || "");
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("dealroom-shell-") && name !== SHELL_CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "doctorcre-share") {
    handleShareMessage(event);
    return;
  }
  if (event.data?.type !== "doctorcre-session-revoked") return;
  retireShare();
  event.waitUntil(
    Promise.all([
      caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name)))),
      self.registration?.pushManager?.getSubscription().then((subscription) => subscription?.unsubscribe()),
    ]),
  );
});
async function networkOnly(request: Request) {
  try {
    return await fetch(request);
  } catch {
    const path = new URL(request.url).pathname;
    if (request.mode === "navigate" && !/^\/(?:auth|api)\//.test(path) && path !== "/mcp")
      return (await caches.match("/offline.html")) || new Response("Offline", { status: 503 });
    return new Response(JSON.stringify({ error: "offline", state: "reconnecting", live: false }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
}
async function shell(request: Request) {
  try {
    const response = await fetch(request);
    if (cacheable(response)) await (await caches.open(SHELL_CACHE)).put(request, response.clone());
    return response;
  } catch {
    return (await caches.match(request)) || new Response("Offline", { status: 503 });
  }
}
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(receiveShare(event.request));
    return;
  }
  // Auth, APIs, MCP and unknown paths never consult CacheStorage. Only the
  // explicit static shell may be cached, regardless of HTTP success.
  if (event.request.method !== "GET" || !staticAsset(url.pathname)) event.respondWith(networkOnly(event.request));
  else event.respondWith(shell(event.request));
});

// Keep custody volatile because /auth/session supplies no durable non-secret
// session identifier. Worker termination drops the share instead of rebinding it.
let pendingShare: Share | null = null;
let receivingShare = false;
let shareTimer: ReturnType<typeof setTimeout> | undefined;
const SHARE_TTL = 600000;
const SHARE_MAX = 26214400;
async function shareSession() {
  const response = await fetch("/auth/session", {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    if ([401, 403].includes(response.status)) retireShare();
    throw Error("Sign in before sharing a file.");
  }
  const session: unknown = await response.json();
  if (
    !object(session) ||
    !object(session.actor) ||
    typeof session.actor.slug !== "string" ||
    typeof session.csrf_token !== "string" ||
    !session.csrf_token
  )
    throw Error("Session unavailable.");
  return session.csrf_token;
}
function retireShare() {
  if (shareTimer) clearTimeout(shareTimer);
  pendingShare = null;
}
async function receiveShare(request: Request) {
  const redirect = (reason: string) =>
    new Response(null, {
      status: 303,
      headers: { location: "/share-intake.html" + (reason ? "?refused=" + reason : ""), "cache-control": "no-store" },
    });
  if (receivingShare || (pendingShare && pendingShare.expires > Date.now())) return redirect("busy");
  receivingShare = true;
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    retireShare();
    if (
      request.headers.get("origin") !== self.location.origin ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return redirect("origin");
    if (!/^multipart\/form-data;/i.test(request.headers.get("content-type") || "")) return redirect("format");
    const session = await shareSession();
    if (!request.body) return redirect("format");
    reader = request.body.getReader();
    let count = 0;
    const buffer = new Uint8Array(SHARE_MAX + 65536);
    const deadline = new Promise<never>((_, reject) => {
      // eslint-disable-next-line no-restricted-syntax -- Single fifteen-second deadline cancels a stalled multipart reader and releases intake custody.
      readTimer = setTimeout(() => {
        void reader?.cancel().catch(() => {});
        reject(Error("Share reception timed out"));
      }, 15000);
    });
    // eslint-disable-next-line no-restricted-syntax -- Limit multipart reception to 25 MiB plus framing under one fifteen-second deadline.
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      count += value.byteLength;
      if (count > SHARE_MAX + 65536) {
        await reader.cancel();
        return redirect("size");
      }
      buffer.set(value, count - value.byteLength);
    }
    const form = await new Response(new Blob([buffer.subarray(0, count)]), {
      headers: { "content-type": request.headers.get("content-type") || "" },
    }).formData();
    const files = form.getAll("files");
    if (files.length !== 1 || [...form.keys()].some((key) => key !== "files")) return redirect("file");
    const file = files[0];
    if (
      !(file instanceof File) ||
      !["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"].includes(file.type) ||
      file.size < 1 ||
      file.size > SHARE_MAX ||
      !file.name.trim() ||
      file.name.length > 255
    )
      return redirect("file");
    if ((await shareSession()) !== session) return redirect("session");
    const active: Share = {
      id: crypto.randomUUID(),
      file,
      session,
      expires: Date.now() + SHARE_TTL,
      keys: { reserve: crypto.randomUUID(), finalize: crypto.randomUUID(), abandon: crypto.randomUUID() },
      operation: null,
    };
    pendingShare = active;
    // eslint-disable-next-line no-restricted-syntax -- A single custody timer retires bytes after ten minutes; it never polls.
    shareTimer = setTimeout(() => {
      if (pendingShare === active) retireShare();
    }, SHARE_TTL);
    return redirect("");
  } catch {
    retireShare();
    return redirect("unavailable");
  } finally {
    if (readTimer) clearTimeout(readTimer);
    receivingShare = false;
  }
}
function handleShareMessage(event: ExtendableMessageEvent) {
  if (event.data?.type !== "doctorcre-share") return;
  event.waitUntil(
    (async () => {
      const reply = (value: unknown) => event.ports[0]?.postMessage(value);
      try {
        if (!event.source || !("url" in event.source) || new URL(event.source.url).origin !== self.location.origin)
          throw Error("Invalid caller");
        if (!pendingShare || pendingShare.expires <= Date.now()) {
          retireShare();
          throw Error("Share expired. Share the file again.");
        }
        const active = pendingShare;
        if (
          (await shareSession()) !== active.session ||
          event.data.csrf !== active.session ||
          pendingShare !== active
        ) {
          retireShare();
          throw Error("Session ended. Share the file again after signing in.");
        }
        if (!("id" in event.source) || typeof event.source.id !== "string" || !event.source.id)
          throw Error("Invalid intake page");
        if (active.clientId && active.clientId !== event.source.id && (await self.clients.get(active.clientId)))
          throw Error("Another intake page is already using this share. Return to it.");
        if (pendingShare !== active || active.expires <= Date.now())
          throw Error("Share expired. Share the file again.");
        active.clientId = event.source.id;
        if (event.data.action === "clear") {
          if (event.data.shareId && event.data.shareId !== active.id) throw Error("Different share.");
          retireShare();
          reply({ ok: true });
          return;
        }
        if (event.data.action === "operation") {
          const next = event.data.operation;
          if (
            !object(next) ||
            typeof next.deal !== "string" ||
            (active.operation && active.operation.deal !== next.deal)
          )
            throw Error("Reconcile the current deal first.");
          active.operation = { ...next, deal: next.deal };
        }
        const { session, clientId, ...share } = active;
        reply({ ok: true, share });
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : "Share unavailable" });
      }
    })(),
  );
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let destination = "/notifications.html";
      try {
        const value: unknown = event.data?.json();
        if (
          object(value) &&
          value.schema_version === "web-push.v1" &&
          typeof value.target_ref === "string" &&
          /^al1_[A-Za-z0-9_-]{1,120}$/.test(value.target_ref)
        )
          destination = `/a/${value.target_ref}`;
      } catch {
        /* Invalid payloads still produce a generic visible notification. */
      }
      await self.registration.showNotification("DoctorCRE", {
        body: "Open DoctorCRE to review.",
        data: { destination },
      });
    })(),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const data: unknown = event.notification.data;
      const path =
        object(data) && typeof data.destination === "string" && /^\/a\/al1_[A-Za-z0-9_-]{1,120}$/.test(data.destination)
          ? data.destination
          : "/notifications.html";
      const url = new URL(path, self.location.origin).href;
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const exact = clients.find((client) => client.url === url);
      if (exact) await exact.focus();
      else await self.clients.openWindow(url);
    })(),
  );
});
