import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appShellMarkup } from "../js/app-shell.js";

// The second, smaller business nav set (Deals/Clients/Vendors, no Leads) was
// missed by the earlier /leads-keyed Tours sweep (PR 68). These five pages
// carry that nav and each must link Tours from it.
// The eight pages PR 68 linked, plus the five above. Some use a page-specific
// nav class (leads-nav), so any <nav> carrying the link counts.
const PAGES = [
  "business.html",
  "index.html",
  "leads.html",
  "progress-work.html",
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
    assert.match(html, /id="appShell"/, `${page} mounts the common navigation`);
    assert.match(appShellMarkup("/tours"), /href="\/tours" aria-current="page">Tours<\/a>/);
  });
}

test("Home removes the repeated Tours action tile; shared navigation still offers Tours", () => {
  const html = readFileSync(new URL("../workspace.html", import.meta.url), "utf8");
  const card = /<a class="module-card[^"]*" href="\/tours">[\s\S]*?<\/a>/.exec(html)?.[0] || "";
  assert.equal(card, "", "Home has no repeated Tours module card");
  assert.doesNotMatch(card, /<p>/);
});
