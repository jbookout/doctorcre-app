import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { appShellMarkup, navigationItems } from "../js/navigation.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * What a reader can actually see, for the copy checks below. A comment
 * promising not to make a claim is not the claim, and asserting against
 * comments is how a truthful file fails a truthfulness test.
 */
const withoutComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|\s)\/\/.*$/gm, "$1");

test("workspace surfaces share navigation while the client portal mounts its dedicated reader", async () => {
  const routes = (await import("../js/routes.js")).routeContract;
  for (const [route, file] of Object.entries(routes.routes)) {
    if (file === "reports/share.html") continue;
    const html = await readFile(`${ROOT}/${file}`, "utf8");
    if (route === "/client-portal") {
      assert.match(html, /id="portalForm"/);
      assert.doesNotMatch(html, /appShell|app-shell|aria-label="Primary navigation"/);
      continue;
    }
    assert.match(html, /id="appShell"/, `${route}: shared shell mount`);
    const nav = appShellMarkup(route);
    assert.equal((nav.match(/data-app-nav-item/g) || []).length, navigationItems.length, `${route}: same destinations`);
  }
  assert.deepEqual(navigationItems.filter(item => !item.group).map(({ label }) => label),
    ["Home", "Leads", "Local Deals", "Tours"]);
});

test("People offers both directories in the shared shell", () => {
  assert.match(appShellMarkup("/clients"), /href="\/clients" aria-current="page">Clients<\/a>/);
  assert.match(appShellMarkup("/vendors"), /href="\/vendors" aria-current="page">Vendors<\/a>/);
});

test("More keeps Updates, Operations and Reference in stable groups", () => {
  const nav = appShellMarkup("/");
  for (const group of ["Updates", "Operations", "Reference"]) {
    assert.match(nav, new RegExp(`app-shell-more-group[^>]*>${group}<`));
  }
  for (const route of ["/updates", "/doc-chats", "/work-requests", "/all-work", "/incidents", "/control-room/progress/work", "/design-lab", "/status"]) {
    assert.match(nav, new RegExp(`href="${route}"`));
  }
  assert.match(nav, /href="\/search" aria-label="Search"/);
  assert.match(nav, /aria-label="Doc Chats"[^>]*href="\/doc-chats"/);
});
