import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";

const root = new URL("../", import.meta.url);
const routes = JSON.parse(readFileSync(new URL("contracts/app-routes.v1.json", root), "utf8")).routes;
const pages = [...new Set(Object.values(routes))];
const expected = ["Home", "Leads", "Tours", "Local Deals", "Vendors", "Control Room", "Clients", "Ideas", "Events", "Updates", "Doc Chats", "Progress", "Work Requests", "All Work", "Incidents", "Agent Room", "Agent Queue", "Design Lab", "Status"];

test("every app route mounts the same navigation before page content", () => {
  for (const page of pages) {
    const html = readFileSync(new URL(page, root), "utf8");
    if (page === "reports/share.html") {
      assert.match(html, /<link rel="stylesheet" href="\/share\.css">/, `${page}: report stylesheet`);
      assert.match(html, /<div id="appShell"><\/div>/, `${page}: shared shell mount`);
    } else {
      assert.match(html, /<link rel="stylesheet" href="\/css\/app-shell\.css">/, `${page}: shared shell styles`);
      assert.match(html, /<div id="appShell"><\/div><script type="module" src="\/js\/app-shell\.js"><\/script>/, `${page}: shared shell mount`);
    }
    assert.equal((html.match(/id="appShell"/g) || []).length, 1, `${page}: exactly one shell`);
    assert.doesNotMatch(html, /class="(?:primary-nav|mobile-nav|leads-nav|room-nav|workspaces|system-work-session)"/, `${page}: no second global navigation`);
  }
});

test("built report uses only report-adapter asset routes and includes the shared shell", async () => {
  const { buildArtifact } = await import("../scripts/artifact.mjs");
  const outDir = await mkdtemp(join(tmpdir(), "doctorcre-report-shell-"));
  try {
    await buildArtifact({ root: new URL("../", import.meta.url).pathname, outDir, commit: "a".repeat(40) });
    const html = await readFile(join(outDir, "site/reports/share.html"), "utf8");
    const script = await readFile(join(outDir, "site/reports/share.js"), "utf8");
    const style = await readFile(join(outDir, "site/reports/share.css"), "utf8");
    const requested = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]);
    const routed = new Set(["/share-bootstrap.js", "/share.js", "/share.css", "/vendor/maplibre-gl-6.4.1/maplibre-gl.css"]);
    assert.deepEqual(requested.filter((path) => !routed.has(path)), [], "every report asset request has an adapter route");
    assert.match(script, /function appShellMarkup\(/, "report JavaScript carries the shared navigation renderer");
    assert.match(style, /\.app-shell-header\{/, "report CSS carries the shared shell styles");
    assert.doesNotMatch(script, /^export /m, "report JavaScript runs without an unrouted module import");
    assert.doesNotThrow(() => new Script(script), "the standalone report bundle parses after removing app-only mounting");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("the shared navigation has one stable set of destinations, including every secondary page", async () => {
  const { navigationItems, appShellMarkup } = await import("../js/app-shell.js");
  assert.deepEqual(navigationItems.map(({ label }) => label), expected);
  for (const route of Object.keys(routes)) {
    const html = appShellMarkup(route);
    const labels = [...html.matchAll(/data-app-nav-item[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(labels, expected, `${route}: same order and items`);
    assert.match(html, />Agent Queue<\/a>/);
    assert.equal((html.match(/aria-current="page"/g) || []).length, route === "/calendar" ? 0 : 1, `${route}: one active destination or utility`);
  }
});

test("Deals has one global Deals link and local views are labelled as views", () => {
  const html = readFileSync(new URL("index.html", root), "utf8");
  assert.match(html, /<body class="night">\s*<script src="\/js\/theme-boot\.js"><\/script>/);
  assert.doesNotMatch(html, /<nav class="workspaces"/);
  assert.match(html, /data-workspace="team"[^>]*>All Deals<\/button>/);
  assert.match(html, /data-workspace="national_account"[^>]*>National Accounts<\/button>/);
  assert.match(html, /href="\/deals\?view=board">Board<\/a>/);
});

test("the task board belongs to Observatory rather than global navigation", () => {
  const room = readFileSync(new URL("room.html", root), "utf8");
  assert.match(room, /<button[^>]*id="openTaskBoard"[^>]*>Task board<\/button>/);
  assert.match(room, /<dialog id="taskBoardDialog"[\s\S]*?<h2 id="taskBoardTitle">Task board<\/h2>/);
  assert.match(room, /src="\/js\/queue\.js"/);
});

test("public report navigation uses its sibling app origin", async () => {
  const { appOriginForReport, appShellMarkup } = await import("../js/app-shell.js");
  const domain = ["example", "test"].join(".");
  const origin = appOriginForReport(`https://reports.${domain}`);
  const appOrigin = `https://app.${domain}`;
  assert.equal(origin, appOrigin);
  assert.equal(appOriginForReport(`https://other.${domain}`), "");
  const shell = appShellMarkup("/share", origin);
  assert.ok(shell.includes(`href="${appOrigin}/deals"`));
  assert.ok(shell.includes(`href="${appOrigin}/" aria-label="DoctorCRE Home"`));
});
