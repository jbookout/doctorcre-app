import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mountTourClientDownload } from "../src/ui/tour-client-download.ts";

test("a changed share context refuses before requesting a download", async () => {
  const dom = new JSDOM("<main></main>");
  const parent = dom.window.document.querySelector("main");
  assert.ok(parent);
  let checks = 0;
  const setAvailable = mountTourClientDownload(parent, async () => {
    checks++;
    throw new Error("share_context_changed");
  });
  setAvailable(true);
  const button = parent.querySelector("button");
  assert.ok(button);
  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checks, 1);
  assert.equal(button.disabled, false);
  assert.equal(parent.querySelector('[role="status"]')?.textContent, "The PDF could not be downloaded. Try again.");
  assert.equal(parent.querySelector("a"), null);
  dom.window.close();
});

test("late download settlement cannot restore a retired control", async () => {
  const dom = new JSDOM("<main></main>");
  const parent = dom.window.document.querySelector("main");
  assert.ok(parent);
  let refuse: ((reason: Error) => void) | undefined;
  const setAvailable = mountTourClientDownload(
    parent,
    () =>
      new Promise((_, reject) => {
        refuse = reject;
      }),
  );
  const button = parent.querySelector("button");
  assert.ok(button);
  assert.equal(button.hidden, true);
  setAvailable(true);
  button.click();
  setAvailable(false);
  assert.ok(refuse);
  refuse(new Error("revoked"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(button.hidden, true);
  assert.equal(button.disabled, true);
  assert.equal(parent.querySelector('[role="status"]')?.textContent, "");
  dom.window.close();
});

test("late PDF bytes cannot download or announce success after retirement", async (t) => {
  const dom = new JSDOM("<main></main>");
  t.after(() => dom.window.close());
  const parent = dom.window.document.querySelector("main");
  assert.ok(parent);
  let finish: ((blob: Blob) => void) | undefined;
  const response = new Response("%PDF-synthetic", { headers: { "content-type": "application/pdf" } });
  t.mock.method(
    response,
    "blob",
    () =>
      new Promise<Blob>((resolve) => {
        finish = resolve;
      }),
  );
  t.mock.method(globalThis, "fetch", async () => response);
  const createObjectURL = t.mock.method(URL, "createObjectURL");
  const setAvailable = mountTourClientDownload(parent, (operation) => operation());
  setAvailable(true);
  const button = parent.querySelector("button");
  assert.ok(button);
  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(finish);
  setAvailable(false);
  finish(new Blob(["%PDF-synthetic"]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createObjectURL.mock.callCount(), 0);
  assert.equal(button.hidden, true);
  assert.equal(button.disabled, true);
  assert.equal(parent.querySelector('[role="status"]')?.textContent, "");
});
