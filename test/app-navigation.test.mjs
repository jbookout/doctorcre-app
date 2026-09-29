import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const routes = JSON.parse(readFileSync(new URL("contracts/app-routes.v1.json", root), "utf8")).routes;
const pages = [...new Set(Object.values(routes))];
const expected = ["Home", "Leads", "Tours", "Deals", "Clients", "Vendors", "Search", "Calendar", "Ideas", "Tasks", "Conversations", "Notifications", "System work", "Observatory"];

test("every app route mounts the same navigation before page content", () => {
  for (const page of pages) {
    const html = readFileSync(new URL(page, root), "utf8");
    assert.match(html, /<link rel="stylesheet" href="\/css\/app-shell\.css">/, `${page}: shared shell styles`);
    assert.match(html, /<div id="appShell"><\/div><script type="module" src="\/js\/app-shell\.js"><\/script>/, `${page}: shared shell mount`);
    assert.equal((html.match(/id="appShell"/g) || []).length, 1, `${page}: exactly one shell`);
    assert.doesNotMatch(html, /class="(?:primary-nav|mobile-nav|leads-nav|room-nav|workspaces|system-work-session)"/, `${page}: no second global navigation`);
  }
});

test("the shared navigation has one stable set of destinations, with no Queue link", async () => {
  const { navigationItems, appShellMarkup } = await import("../js/app-shell.js");
  assert.deepEqual(navigationItems.map(({ label }) => label), expected);
  for (const route of Object.keys(routes)) {
    const html = appShellMarkup(route);
    const labels = [...html.matchAll(/data-app-nav-item[^>]*>([^<]+)/g)].map((match) => match[1]);
    assert.deepEqual(labels, expected, `${route}: same order and items`);
    assert.doesNotMatch(html, />Queue<\/a>/);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1, `${route}: one active destination`);
  }
});

test("Deals has one global Deals link and local views are labelled as views", () => {
  const html = readFileSync(new URL("index.html", root), "utf8");
  assert.match(html, /<body class="night">\s*<script src="\/js\/theme-boot\.js"><\/script>/);
  assert.doesNotMatch(html, /<nav class="workspaces"/);
  assert.match(html, /data-workspace="team"[^>]*>All deals<\/button>/);
  assert.match(html, /data-workspace="national_account"[^>]*>National accounts<\/button>/);
});

test("the task board belongs to Observatory rather than global navigation", () => {
  const room = readFileSync(new URL("room.html", root), "utf8");
  assert.match(room, /<button[^>]*id="openTaskBoard"[^>]*>Task board<\/button>/);
  assert.match(room, /<dialog id="taskBoardDialog"[\s\S]*?<h2 id="taskBoardTitle">Task board<\/h2>/);
  assert.match(room, /src="\/js\/queue\.js"/);
});

test("public report navigation returns to the app host", async () => {
  const { appShellMarkup } = await import("../js/app-shell.js");
  const shell = appShellMarkup("/share", "https://app.doctorcre.com");
  assert.match(shell, /href="https:\/\/app\.doctorcre\.com\/deals"/);
  assert.match(shell, /href="https:\/\/app\.doctorcre\.com\/" aria-label="DoctorCRE Home"/);
});
