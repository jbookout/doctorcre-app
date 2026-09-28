import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { mountNotificationResume } from "../js/notification-resume.mjs";

function events(initial = "visible") {
  const listeners = new Map();
  const doc = {
    visibilityState: initial,
    addEventListener(name, fn) { listeners.set(`doc:${name}`, fn); },
  };
  const win = { addEventListener(name, fn) { listeners.set(`win:${name}`, fn); } };
  return {
    doc, win,
    visibility(state) { doc.visibilityState = state; listeners.get("doc:visibilitychange")(); },
    pagehide() { listeners.get("win:pagehide")(); },
    pageshow(persisted) { listeners.get("win:pageshow")({ persisted }); },
  };
}

test("a hidden Notifications page reads the feed once when it becomes visible", async () => {
  const browser = events();
  let reads = 0;
  mountNotificationResume({ document: browser.doc, window: browser.win, refresh: async () => { reads++; } });
  browser.visibility("hidden");
  browser.visibility("visible");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  browser.visibility("visible");
  browser.pageshow(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, "one resume cannot issue a second read through pageshow");
});

test("a back-forward cache restore reads, while ordinary pageshow and hidden pages do not", async () => {
  const browser = events();
  let reads = 0;
  mountNotificationResume({ document: browser.doc, window: browser.win, refresh: async () => { reads++; } });
  browser.pageshow(false);
  browser.visibility("hidden");
  browser.pageshow(true);
  assert.equal(reads, 0);
  browser.pageshow(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 0);
  browser.doc.visibilityState = "visible";
  browser.pageshow(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
});

test("failed reads can be retried on the next actual resume", async () => {
  const browser = events();
  let reads = 0;
  mountNotificationResume({ document: browser.doc, window: browser.win, refresh: async () => {
    reads++;
    if (reads === 1) throw new Error("synthetic feed failure");
  } });
  browser.visibility("hidden");
  browser.visibility("visible");
  await new Promise((resolve) => setImmediate(resolve));
  browser.visibility("hidden");
  browser.visibility("visible");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
});

test("each back-forward restore reads again even when the browser skips visibilitychange", async () => {
  const browser = events();
  let reads = 0;
  mountNotificationResume({ document: browser.doc, window: browser.win, refresh: async () => { reads++; } });
  browser.pagehide();
  browser.pageshow(true);
  await new Promise((resolve) => setImmediate(resolve));
  browser.pagehide();
  browser.pageshow(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
});

test("a second return while a read is in flight queues one fresh read", async () => {
  const browser = events();
  let complete;
  let reads = 0;
  mountNotificationResume({ document: browser.doc, window: browser.win, refresh: async () => {
    reads++;
    if (reads === 1) await new Promise((resolve) => { complete = resolve; });
  } });
  browser.visibility("hidden");
  browser.visibility("visible");
  await new Promise((resolve) => setImmediate(resolve));
  browser.visibility("hidden");
  browser.visibility("visible");
  assert.equal(reads, 1);
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
});

test("the shipped Notifications page binds resume to its existing read path", async () => {
  const source = await readFile(new URL("../js/notifications.js", import.meta.url), "utf8");
  assert.match(source, /mountNotificationResume\(\{[\s\S]*?refresh:\s*load/);
  assert.doesNotMatch(source, /setInterval\(/);
});
