import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { showToast } from "../js/toast.js";

function documentFor(t) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => {
    dom.window.close();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  return dom.window.document;
}

test("success toast holds for two seconds, then fades out and removes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const doc = documentFor(t);
  const toast = showToast("Saved");

  assert.equal(toast.getAttribute("role"), "status");
  assert.equal(toast.dataset.transient, "", "the shared CSS can target lifecycle-managed toasts");
  assert.equal(toast.textContent, "Saved");
  t.mock.timers.tick(1999);
  assert.equal(toast.classList.contains("is-leaving"), false);
  t.mock.timers.tick(1);
  assert.equal(toast.classList.contains("is-leaving"), true);
  t.mock.timers.tick(799);
  assert.equal(toast.isConnected, true);
  t.mock.timers.tick(1);
  assert.equal(toast.isConnected, false);
  assert.equal(doc.querySelectorAll(".toast").length, 0);
});

test("Undo toast exposes its event for five seconds, then disables the action and fades", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const doc = documentFor(t);
  const toast = showToast("Moved to Legal", { eventId: "event-7" });
  const undo = toast.querySelector("button[data-undo]");

  assert.equal(undo.dataset.undo, "event-7");
  assert.equal(undo.disabled, false);
  t.mock.timers.tick(4999);
  assert.equal(undo.disabled, false);
  t.mock.timers.tick(1);
  assert.equal(undo.disabled, true);
  assert.equal(toast.classList.contains("is-leaving"), true);
  t.mock.timers.tick(800);
  assert.equal(doc.querySelector(".toast"), null);
});

test("errors stay visible until closed, and replacing a toast leaves only the newest one", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const doc = documentFor(t);
  const prior = showToast("Saved");
  t.mock.timers.tick(1000);
  const error = showToast("Could not save", { error: true });

  assert.equal(prior.isConnected, false);
  assert.equal(error.getAttribute("role"), "alert");
  assert.equal(doc.querySelectorAll(".toast").length, 1);
  t.mock.timers.tick(10_000);
  assert.equal(error.isConnected, true);
  error.querySelector("button[data-toast-close]").click();
  assert.equal(error.isConnected, false);
});

test('quick successes replace each other and old timers never remove the newest toast', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const doc = documentFor(t);
  const first = showToast('First update');
  t.mock.timers.tick(1900);
  const latest = showToast('Second update');
  assert.equal(first.isConnected, false);
  t.mock.timers.tick(900);
  assert.equal(doc.querySelectorAll('.toast').length, 1);
  assert.equal(latest.classList.contains('is-leaving'), false);
  t.mock.timers.tick(1100);
  t.mock.timers.tick(800);
  assert.equal(doc.querySelectorAll('.toast').length, 0);
});
