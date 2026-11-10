import { focusManager } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import type { PushState } from "./phone-push-model.ts";
import { createPhonePush } from "./phone-push-model.ts";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
const messages: Record<PushState["kind"], string> = {
  off: "Phone notifications are off on this installation.",
  unsupported: "Phone notifications need a supported browser. On iPhone or iPad, open the installed Home Screen app.",
  denied: "Notifications are blocked. Change this app’s notification permission in your phone or browser settings.",
  pending: "Waiting for permission and server confirmation…",
  unknown: "Registration is unconfirmed. Check the outcome before trying another registration.",
  enabled: "Phone notifications are enabled on this installation. Phone delivery has not been verified.",
  revoking: "Turning off this installation on the server…",
  "revoke-unknown": "Revocation is unconfirmed. Check the outcome. The browser subscription is retained.",
  "local-cleanup": "Server registration is revoked. Browser cleanup needs another attempt.",
  retired: "Session ended. Sign in again to manage this installation.",
};
export function mountPhonePush(element: Element, options: Parameters<typeof createPhonePush>[0]) {
  const root = createRoot(element);
  const model = createPhonePush({
    ...options,
    changed(state) {
      options.changed(state);
      render(state);
    },
  });
  function render(state: PushState) {
    const busy = ["pending", "revoking", "retired", "unsupported"].includes(state.kind);
    const disabling = ["enabled", "revoke-unknown", "local-cleanup"].includes(state.kind);
    root.render(
      <section aria-label="Phone notifications" className="card glass">
        <h2>Phone notifications</h2>
        <p role="status" aria-live="polite">
          {messages[state.kind]}
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void (disabling ? model.disable() : model.enable())}
        >
          {state.kind === "unknown" || state.kind === "revoke-unknown"
            ? "Check outcome"
            : state.kind === "local-cleanup"
              ? "Retry browser cleanup"
              : disabling
                ? "Disable phone notifications"
                : "Enable phone notifications"}
        </button>
      </section>,
    );
  }
  render(model.state());
  return {
    refresh: model.refresh,
    retire: model.retire,
    dispose() {
      model.retire();
      root.unmount();
    },
  };
}

async function start(element: Element) {
  const lifetime = new AbortController();
  let view: ReturnType<typeof mountPhonePush> | undefined;
  const retire = () => {
    lifetime.abort();
    if (view) view.retire();
    else element.textContent = "Session ended. Sign in again to manage this installation.";
  };
  addEventListener("doctorcre-offline-session-revoked", retire);
  addEventListener("storage", (event) => {
    if (event.key === "doctorcre-session-epoch-v1") retire();
  });
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type === "doctorcre-session-revoked") retire();
  });
  const read = async (path: string) => {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]),
    });
    if ([401, 403].includes(response.status)) retire();
    if (!response.ok) throw Error("Unavailable");
    const value: unknown = await response.json();
    return value;
  };
  try {
    const session = await read("/auth/session");
    if (
      !object(session) ||
      !object(session.actor) ||
      typeof session.actor.slug !== "string" ||
      typeof session.csrf_token !== "string"
    )
      throw Error("Session unavailable");
    const token = session.csrf_token;
    async function call(verb: string, args: Record<string, string | number>) {
      const current = await read("/auth/session");
      if (!object(current) || current.csrf_token !== token) {
        retire();
        throw Error("Session changed");
      }
      const response = await fetch("/mcp", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "content-type": "application/json", "x-carr-csrf": token },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name: verb, arguments: args },
        }),
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]),
      });
      if ([401, 403].includes(response.status)) retire();
      const envelope: unknown = await response.json();
      if (!response.ok || !object(envelope) || !object(envelope.result)) throw Error("Unconfirmed");
      let result: unknown = envelope.result.structuredContent;
      if (!object(result)) {
        const content = envelope.result.content;
        if (!Array.isArray(content) || !object(content[0]) || typeof content[0].text !== "string")
          throw Error("Unconfirmed");
        result = JSON.parse(content[0].text);
      }
      if (envelope.result.isError)
        throw Error(object(result) && typeof result.error === "string" ? result.error : "Unconfirmed");
      return result;
    }
    let config: unknown;
    try {
      config = await call("read-web-push-config-v1", {});
    } catch (error) {
      if (lifetime.signal.aborted) return;
      if (error instanceof Error && error.message === "push_not_configured") {
        element.textContent = "Phone notifications are unavailable until the public notification key is configured.";
        return;
      }
      if (!(error instanceof Error) || error.message !== "push_config_invalid") throw error;
    }
    if (
      !object(config) ||
      config.ok !== true ||
      config.schema_version !== "web-push-config.v1" ||
      config.vapid_key_version !== "v1" ||
      typeof config.public_key !== "string" ||
      !/^B[A-Za-z0-9_-]{86}$/.test(config.public_key)
    ) {
      element.textContent =
        "Phone notifications are unavailable because the public notification configuration is invalid.";
      return;
    }
    if (lifetime.signal.aborted) return;
    const key = Uint8Array.from(atob(config.public_key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const storageKey = `doctorcre-push-installation-v1:${session.actor.slug}`;
    let installation = localStorage.getItem(storageKey);
    if (!installation || !/^[a-f0-9-]{36}$/.test(installation)) {
      installation = crypto.randomUUID();
      localStorage.setItem(storageKey, installation);
    }
    const supported = () =>
      isSecureContext &&
      "serviceWorker" in navigator &&
      "PushManager" in globalThis &&
      "Notification" in globalThis &&
      (!/iPad|iPhone|iPod/.test(navigator.userAgent) || matchMedia("(display-mode: standalone)").matches);
    if (supported()) {
      element.textContent = "Preparing phone notifications…";
      try {
        await Promise.race([
          navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready),
          new Promise<never>((_, reject) => {
            AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]).addEventListener(
              "abort",
              () => reject(Error("Notification worker unavailable")),
              { once: true },
            );
          }),
        ]);
      } catch {
        if (!lifetime.signal.aborted)
          element.textContent = "Phone notification setup failed. Reopen Updates to try again.";
        return;
      }
      if (lifetime.signal.aborted) return;
    }
    const fingerprint = async () => {
      const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (!subscription) return null;
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(subscription.toJSON())),
      );
      return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
    };
    view = mountPhonePush(element, {
      async inspect() {
        const response = await call("read-web-push-subscriptions-v1", {});
        if (
          !object(response) ||
          response.ok !== true ||
          response.schema_version !== "web-push-registry.v1" ||
          !Array.isArray(response.subscriptions)
        )
          throw Error("Unknown registry");
        const row: unknown = response.subscriptions.find(
          (r: unknown) => object(r) && r.installation_id === installation,
        );
        if (row === undefined) return { generation: 0, active: false, matching: false };
        if (
          !object(row) ||
          typeof row.generation !== "number" ||
          !Number.isSafeInteger(row.generation) ||
          row.generation < 1 ||
          !["active", "revoked", "expired"].includes(String(row.state))
        )
          throw Error("Unknown registry");
        const hash = await fingerprint();
        return {
          generation: row.generation,
          active: row.state === "active",
          matching: hash !== null && localStorage.getItem(`${storageKey}:receipt`) === `${row.generation}:${hash}`,
        };
      },
      async confirmed(generation) {
        const hash = await fingerprint();
        if (hash) localStorage.setItem(`${storageKey}:receipt`, `${generation}:${hash}`);
      },
      call,
      installation,
      supported,
      changed() {},
      permission: () => Notification.permission,
      requestPermission: () => Notification.requestPermission(),
      async subscribe() {
        const registration = await navigator.serviceWorker.ready;
        const subscription =
          (await registration.pushManager.getSubscription()) ??
          (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
        const subscribedKey = subscription.options.applicationServerKey;
        if (
          !subscribedKey ||
          !new Uint8Array(subscribedKey).every((byte, index) => key[index] === byte) ||
          subscribedKey.byteLength !== key.length
        )
          throw Error("Notification key changed. Disable this installation before registering another key.");
        const data = subscription.toJSON();
        if (!data.endpoint || !data.keys?.p256dh || !data.keys.auth) throw Error("Subscription unavailable");
        return { endpoint: data.endpoint, p256dh: data.keys.p256dh, auth: data.keys.auth };
      },
      async unsubscribe() {
        return await (await navigator.serviceWorker.ready).pushManager
          .getSubscription()
          .then((subscription) => subscription?.unsubscribe() ?? true);
      },
    });
    await view.refresh();
    let foregroundReads = 0;
    const stopForeground = focusManager.subscribe((focused) => {
      if (focused && ++foregroundReads <= 20) void view?.refresh();
    });
    addEventListener("pagehide", stopForeground, { once: true });
  } catch {
    if (!lifetime.signal.aborted) element.textContent = "Sign in and reconnect to manage phone notifications.";
  }
}
const element = typeof document === "undefined" ? null : document.querySelector("#phonePush");
if (element) void start(element);
