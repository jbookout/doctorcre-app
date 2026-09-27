import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// The second, smaller business nav set (Deals/Clients/Vendors, no Leads) was
// missed by the earlier /leads-keyed Tours sweep (PR 68). These five pages
// carry that nav and each must link Tours from it.
const PAGES = [
  "calendar.html",
  "ideas.html",
  "pipeline.html",
  "control-room.html",
  "business-workspace.html",
];

for (const page of PAGES) {
  test(`${page} primary nav links Tours`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    const nav = /<nav class="primary-nav"[\s\S]*?<\/nav>/.exec(html)?.[0] || "";
    assert.notEqual(nav, "", `${page} has a primary-nav`);
    assert.match(nav, /<a href="\/tours">Tours<\/a>/, `${page} primary nav includes the Tours link`);
  });
}
