import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mountTourClientDownload } from "../src/ui/tour-client-download.ts";

test("a changed share context refuses before requesting a download", async () => {
  const dom = new JSDOM("<main></main>");
  const parent = dom.window.document.querySelector("main");
  assert.ok(parent);
  let checks = 0;
  mountTourClientDownload(parent, async () => {
    checks++;
    throw new Error("share_context_changed");
  });
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
