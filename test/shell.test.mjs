// V5-UX-B12b — the shared shell's unread-notifications badge.
//
// `mountNotificationBadge` (js/shell.js) is the one function every page's
// top bar calls after it builds its own dealroom client. Its whole contract:
//
//   1. loaded from `notification-feed`'s own `unread_count` on entry and
//      return, never recomputed and never polled by an interval;
//   2. hidden when the count is zero, and hidden (not a fake zero, not an
//      error) when the read fails or the payload is malformed;
//   3. accessible — the visible badge carries an aria-label naming the count
//      in words, and that label is removed along with the count when hidden.
//
// A tiny stub badge element stands in for the DOM: this file has no browser,
// and the other DOM-driving suites in this repo (dealroom-call-mode.test.mjs)
// use the same kind of minimal stub rather than a full jsdom dependency.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

import { mountNotificationBadge } from "../js/shell.js";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

class StubBadge {
  constructor() {
    this.hidden = true;
    this.textContent = "";
    this.attributes = new Map();
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
}

/** Installs a `document` with exactly one element, under the given id. */
function withBadgeDocument(id, run) {
  const badge = new StubBadge();
  const saved = globalThis.document;
  globalThis.document = { getElementById: (wanted) => (wanted === id ? badge : null) };
  return Promise.resolve(run(badge)).finally(() => { globalThis.document = saved; });
}

test("B12b-shell-1: a positive unread_count shows the badge with the number and a plural aria-label", () => withBadgeDocument("navUnreadBadge", async (badge) => {
  const client = { notificationFeed: async (args) => { assert.deepEqual(args, { limit: 1 }); return { unread_count: 3, notifications: [] }; } };
  await mountNotificationBadge(client);
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "3");
  assert.equal(badge.getAttribute("aria-label"), "3 unread notifications");
}));

test("B12b-shell-2: exactly one unread notification gets the singular aria-label", () => withBadgeDocument("navUnreadBadge", async (badge) => {
  const client = { notificationFeed: async () => ({ unread_count: 1, notifications: [] }) };
  await mountNotificationBadge(client);
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "1");
  assert.equal(badge.getAttribute("aria-label"), "1 unread notification");
}));

test("B12b-shell-3: zero unread hides the badge and clears any label — a zero is never printed", () => withBadgeDocument("navUnreadBadge", async (badge) => {
  const client = { notificationFeed: async () => ({ unread_count: 0, notifications: [] }) };
  await mountNotificationBadge(client);
  assert.equal(badge.hidden, true);
  assert.equal(badge.textContent, "");
  assert.equal(badge.getAttribute("aria-label"), null);
}));

test("B12b-shell-4: a rejected read hides the badge instead of drawing an error or a stale number", () => withBadgeDocument("navUnreadBadge", async (badge) => {
  const client = { notificationFeed: async () => { throw new Error("refused"); } };
  await mountNotificationBadge(client);
  assert.equal(badge.hidden, true);
  assert.equal(badge.textContent, "");
  assert.equal(badge.getAttribute("aria-label"), null);
}));

test("B12b-shell-5: a malformed payload (no integer unread_count) hides the badge rather than printing NaN or undefined", () => withBadgeDocument("navUnreadBadge", async (badge) => {
  const client = { notificationFeed: async () => ({ unread_count: "3", notifications: [] }) };
  await mountNotificationBadge(client);
  assert.equal(badge.hidden, true);
  assert.equal(badge.textContent, "");
}));

test("B12b-shell-6: a page with no badge element in its markup is a silent no-op, and a client that is never called is never polled", () => withBadgeDocument("otherId", async () => {
  let calls = 0;
  const client = { notificationFeed: async () => { calls += 1; return { unread_count: 5, notifications: [] }; } };
  await mountNotificationBadge(client, { elementId: "navUnreadBadge" });
  assert.equal(calls, 0, "no element, no request — this is the pages that carry no shared shell at all");
}));

test("B12b-shell-7: one call, one read — nothing here polls", () => withBadgeDocument("navUnreadBadge", async () => {
  let calls = 0;
  const client = { notificationFeed: async () => { calls += 1; return { unread_count: 2, notifications: [] }; } };
  await mountNotificationBadge(client);
  assert.equal(calls, 1);
}));

test("returning to an open page refreshes its unread badge once, and a failed read clears the old number", async () => {
  const badge = new StubBadge();
  const savedDocument = globalThis.document;
  const savedWindow = globalThis.window;
  const listeners = new Map();
  const document = {
    visibilityState: "visible",
    getElementById: () => badge,
    addEventListener: (name, listener) => listeners.set(`doc:${name}`, listener),
  };
  globalThis.document = document;
  globalThis.window = { addEventListener: (name, listener) => listeners.set(`win:${name}`, listener) };
  let calls = 0;
  const client = { notificationFeed: async () => {
    calls += 1;
    if (calls === 2) throw new Error("synthetic refusal");
    return { unread_count: calls === 1 ? 3 : 1 };
  } };
  try {
    await mountNotificationBadge(client);
    assert.equal(badge.textContent, "3");
    document.visibilityState = "hidden";
    listeners.get("doc:visibilitychange")();
    document.visibilityState = "visible";
    listeners.get("doc:visibilitychange")();
    listeners.get("win:pageshow")({ persisted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, "one return causes one read");
    assert.equal(badge.hidden, true, "the refused read cannot leave a stale count visible");
    document.visibilityState = "hidden";
    listeners.get("doc:visibilitychange")();
    document.visibilityState = "visible";
    listeners.get("doc:visibilitychange")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 3);
    assert.equal(badge.textContent, "1");
  } finally {
    globalThis.document = savedDocument;
    globalThis.window = savedWindow;
  }
});

test("an older initial unread response cannot overwrite the returned page's newer count", async () => {
  const badge = new StubBadge();
  const savedDocument = globalThis.document;
  const savedWindow = globalThis.window;
  const listeners = new Map();
  const document = {
    visibilityState: "visible",
    getElementById: () => badge,
    addEventListener: (name, listener) => listeners.set(`doc:${name}`, listener),
  };
  globalThis.document = document;
  globalThis.window = { addEventListener: (name, listener) => listeners.set(`win:${name}`, listener) };
  let finishFirst;
  let calls = 0;
  const client = { notificationFeed: () => {
    calls += 1;
    return calls === 1
      ? new Promise((resolve) => { finishFirst = resolve; })
      : Promise.resolve({ unread_count: 1 });
  } };
  try {
    const initial = mountNotificationBadge(client);
    document.visibilityState = "hidden";
    listeners.get("doc:visibilitychange")();
    document.visibilityState = "visible";
    listeners.get("doc:visibilitychange")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(badge.textContent, "1");
    finishFirst({ unread_count: 4 });
    await initial;
    assert.equal(badge.textContent, "1", "stale first read is ignored");
  } finally {
    globalThis.document = savedDocument;
    globalThis.window = savedWindow;
  }
});

/* -------------------------------------------------------------- the markup */

// Every page carrying the shared top bar gets the badge element, and every
// page-specific script that builds its own dealroom client wires it up. The
// three design/*.html prototypes are the deliberate exception (visual-system
// test: "free of network calls"): they carry no client at all, so the badge
// stays in the markup, permanently hidden, wired to nothing.
const PAGES_WITH_BADGE_JS = [
  ["business-workspace.html", "js/business-workspace.js"],
  ["control-room.html", "js/control-room.js"],
  ["incidents.html", "js/incidents.js"],
  ["pipeline.html", "js/pipeline.js"],
  ["notifications.html", "js/notifications.js"],
  ["tasks.html", "js/task-records.js"],
  ["work-inventory.html", "js/work-inventory.js"],
  ["conversations.html", "js/conversations.js"],
  ["business.html", "js/workspace-business.js"],
  ["workspace.html", "js/workspace-command-center.js"],
  ["calendar.html", "js/calendar.js"],
  ["ideas.html", "js/ideas.js"],
];
const PAGES_WITHOUT_BADGE_JS = ["design.html", "design-business.html", "design-operations.html"];

test("B12b-shell-8: every page with the shared top bar carries the navUnreadBadge element", async () => {
  for (const [page] of PAGES_WITH_BADGE_JS) {
    const html = await read(page);
    assert.match(html, /id="navUnreadBadge"/, page);
  }
  for (const page of PAGES_WITHOUT_BADGE_JS) {
    const html = await read(page);
    assert.match(html, /id="navUnreadBadge"/, page);
  }
});

test("B12b-shell-9: every page whose script builds a dealroom client also mounts the badge from it", async () => {
  for (const [, script] of PAGES_WITH_BADGE_JS) {
    const source = await read(script);
    assert.match(source, /mountNotificationBadge\(/, script);
  }
});

test("B12b-shell-10: the design prototypes stay free of network calls — no client, no badge wiring, matching the visual-system prototype rule", async () => {
  const source = await read("js/design-prototype.js");
  assert.doesNotMatch(source, /mountNotificationBadge|createLiveClient|createFixtureClient/, "js/design-prototype.js");
});

test("B12b-shell-11: the badge is hidden in every page's own markup, so a page whose script never runs shows nothing", async () => {
  const pages = (await readdir(new URL(".", ROOT))).filter((name) => name.endsWith(".html"));
  for (const page of pages) {
    const html = await read(page);
    const match = html.match(/<span class="nav-badge" id="navUnreadBadge"([^>]*)>/);
    if (!match) continue;
    assert.match(match[1], /\bhidden\b/, `${page}: navUnreadBadge must start hidden`);
  }
});
