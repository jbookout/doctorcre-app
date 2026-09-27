import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// The second, smaller business nav set (Deals/Clients/Vendors, no Leads) was
// missed by the earlier /leads-keyed Tours sweep (PR 68). These five pages
// carry that nav and each must link Tours from it.
// The eight pages PR 68 linked, plus the five above. Some use a page-specific
// nav class (leads-nav), so any <nav> carrying the link counts.
const PAGES = [
  "business.html",
  "index.html",
  "leads.html",
  "queue.html",
  "system-work.html",
  "tasks.html",
  "work-inventory.html",
  "workspace.html",
  "calendar.html",
  "ideas.html",
  "pipeline.html",
  "control-room.html",
  "business-workspace.html",
];

for (const page of PAGES) {
  test(`${page} nav links Tours`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    const navs = html.match(/<nav\b[\s\S]*?<\/nav>/g) || [];
    assert.ok(navs.length > 0, `${page} has a nav`);
    assert.ok(navs.some((nav) => /<a\b[^>]*href="\/tours"[^>]*>Tours<\/a>/.test(nav)), `${page} nav includes the Tours link`);
  });
}

test("Home Tours card carries no sentence under its title", () => {
  const html = readFileSync(new URL("../workspace.html", import.meta.url), "utf8");
  const card = /<a class="module-card[^"]*" href="\/tours">[\s\S]*?<\/a>/.exec(html)?.[0] || "";
  assert.notEqual(card, "", "Home has a Tours module card");
  assert.doesNotMatch(card, /<p>/);
});
