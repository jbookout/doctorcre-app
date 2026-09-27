// Tours page primary navigation: tours/index.html must carry the same app-wide
// primary nav as its sibling pages (queue.html, system-work.html, workspace.html),
// with Tours marked as the current page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../tours/index.html", import.meta.url)), "utf8");

test("tours/index.html carries a primary nav with links to Home, Leads, Deals", () => {
  const nav = html.match(/<nav class="primary-nav"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(nav, "expected a <nav class=\"primary-nav\"> block in tours/index.html");
  assert.match(nav, /href="\/"/);
  assert.match(nav, /href="\/leads"/);
  assert.match(nav, /href="\/deals"/);
});

test("the primary nav marks Tours as the active/current page", () => {
  const nav = html.match(/<nav class="primary-nav"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.match(
    nav,
    /<a[^>]*class="active"[^>]*aria-current="page"[^>]*>Tours<\/a>|<a[^>]*aria-current="page"[^>]*class="active"[^>]*>Tours<\/a>/,
  );
});
