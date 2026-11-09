import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { uiAssets } from "../scripts/ui-bundle.mjs";

const assets = await uiAssets((path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const workerAsset = assets.get("public-shell/sw.js");
assert.ok(workerAsset, "bundle emits the service worker");
const source = workerAsset.toString();
function worker() {
  const handlers = new Map<string, (event: object) => void>();
  const shown: { title: string; options: { body: string; data: { destination: string } } }[] = [];
  const opened: string[] = [],
    focused: string[] = [],
    deleted: string[] = [];
  let unsubscribed = false;
  const context = {
    URL,
    Response,
    self: {
      location: { origin: "https://app.example.test" },
      addEventListener: (name: string, handler: (event: object) => void) => handlers.set(name, handler),
      skipWaiting: async () => {},
      registration: {
        pushManager: {
          getSubscription: async () => ({
            unsubscribe: async () => {
              unsubscribed = true;
              return true;
            },
          }),
        },
        showNotification: async (title: string, options: { body: string; data: { destination: string } }) => {
          shown.push({ title, options });
        },
      },
      clients: {
        claim: async () => {},
        matchAll: async () => [
          {
            url: "https://app.example.test/",
            focus: async () => {
              focused.push("home");
            },
          },
        ],
        openWindow: async (url: string) => {
          opened.push(url);
        },
      },
    },
    caches: {
      keys: async () => ["dealroom-shell-v6", "dealroom-shell-v7"],
      delete: async (name: string) => {
        deleted.push(name);
      },
      open: async () => ({ addAll: async () => {} }),
    },
  };
  vm.runInNewContext(source, context);
  async function event(name: string, data: object) {
    let pending: Promise<unknown> | undefined;
    const handler = handlers.get(name);
    assert.ok(handler);
    handler({
      ...data,
      waitUntil: (p: Promise<unknown>) => {
        pending = p;
      },
    });
    await pending;
  }
  return { shown, opened, focused, deleted, event, unsubscribed: () => unsubscribed };
}
test("push shows only generic text and click opens the exact same-origin card", async () => {
  const w = worker();
  await w.event("push", {
    data: {
      json: () => ({
        schema_version: "web-push.v1",
        target_ref: "al1_exact-card",
        title: "private title",
        body: "private body",
      }),
    },
  });
  assert.equal(w.shown[0]?.title, "DoctorCRE");
  assert.equal(w.shown[0]?.options.body, "Open DoctorCRE to review.");
  await w.event("notificationclick", { notification: { close() {}, data: w.shown[0]?.options.data } });
  assert.deepEqual(w.opened, ["https://app.example.test/a/al1_exact-card"]);
  assert.deepEqual(w.focused, []);
});
test("malformed push and forged notification destination use the safe generic page", async () => {
  const w = worker();
  await w.event("push", {
    data: {
      json: () => {
        throw Error("bad");
      },
    },
  });
  assert.equal(w.shown.length, 1);
  await w.event("notificationclick", {
    notification: { close() {}, data: { destination: "https://foreign.example/private" } },
  });
  assert.deepEqual(w.opened, ["https://app.example.test/notifications.html"]);
});
test("worker update retires the previous shell cache and session invalidation clears caches", async () => {
  const w = worker();
  await w.event("install", {});
  await w.event("activate", {});
  assert.deepEqual(w.deleted, ["dealroom-shell-v6"]);
  await w.event("message", { data: { type: "doctorcre-session-revoked" } });
  assert.deepEqual(w.deleted, ["dealroom-shell-v6", "dealroom-shell-v6", "dealroom-shell-v7"]);
  assert.equal(w.unsubscribed(), true);
});
