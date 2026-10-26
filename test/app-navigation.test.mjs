import { navigationItems } from "../js/navigation.js";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";

const root = new URL("../", import.meta.url);
const routes = (await import("../js/routes.js")).routeContract.routes;
const pages = [...new Set(Object.values(routes))];
const expected = navigationItems.map(item => item.label);

test("workspace routes share navigation while the client portal stays outside the broker shell", () => {
  for (const page of pages) {
    const html = readFileSync(new URL(page, root), "utf8");
    if (page === "client-portal.html") {
      assert.doesNotMatch(html, /appShell|app-shell|navigation\.js|doc-context|doc-panel/, "client portal has no broker workspace shell");
      assert.match(html, /src="\/js\/client-portal\.js"/, "client portal mounts its dedicated reader");
      continue;
    }
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
    assert.match(script, /<nav class="app-shell-navigation" aria-label="Primary navigation">/, "report JavaScript carries the shared navigation markup");
    assert.match(script, /class="app-shell-more-toggle/, "report JavaScript carries the More menu");
    assert.match(style, /\.app-shell-header\s*\{/, "report CSS carries the shared shell styles");
    assert.doesNotMatch(script, /^export /m, "report JavaScript runs without an unrouted module import");
    assert.doesNotThrow(() => new Script(script), "the standalone report bundle parses after removing app-only mounting");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("the shared navigation has one stable set of destinations, including every secondary page", async () => {
  const { appShellMarkup } = await import("../js/navigation.js");
  for (const route of Object.keys(routes)) {
    const html = appShellMarkup(route);
    const labels = [...html.matchAll(/data-app-nav-item[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(labels, expected, `${route}: same order and items`);
    assert.match(html, />Project activity<\/a>/);
    assert.doesNotMatch(html, />Agent (?:Room|Queue)<\/a>/);
    assert.equal((html.replace(/<a data-phone-more[^>]*>/g, "").match(/aria-current="page"/g) || []).length, ["/calendar", "/client-portal"].includes(route) ? 0 : 1, `${route}: one active destination or utility when included in navigation`);
  }
});

test("Deals has one global Deals link and local views are labelled as views", () => {
  const html = readFileSync(new URL("index.html", root), "utf8");
  assert.match(html, /<body>\s*<script src="\/js\/theme-boot\.js"><\/script>/, "theme lives on <html>; the body carries no theme class");
  assert.doesNotMatch(html, /<nav class="workspaces"/);
  assert.match(html, /data-workspace="team"[^>]*>All Deals<\/button>/);
  assert.match(html, /data-workspace="national_account"[^>]*>National Accounts<\/button>/);
  assert.match(html, /href="\/deals\?view=board">Board<\/a>/);
});

test("the task board belongs to Progress work detail", () => {
  const room = readFileSync(new URL("progress-work.html", root), "utf8");
  assert.match(room, /id="workTasks"/);
  assert.match(room, /id="queueColumns"/);
  assert.match(room, /src="\/js\/queue\.js"/);
});

test("public report navigation uses its sibling app origin", async () => {
  const { appOriginForReport, appShellMarkup } = await import("../js/navigation.js");
  const domain = ["example", "test"].join(".");
  const origin = appOriginForReport(`https://reports.${domain}`);
  const appOrigin = `https://app.${domain}`;
  assert.equal(origin, appOrigin);
  assert.equal(appOriginForReport(`https://other.${domain}`), "");
  const shell = appShellMarkup("/share", origin);
  assert.ok(shell.includes(`href="${appOrigin}/deals"`));
  assert.ok(shell.includes(`href="${appOrigin}/" aria-label="DoctorCRE Home"`));
});

test('report navigation mounts through its module without partner controls and keeps More keyboard behavior', async () => {
  const { JSDOM } = await import('jsdom');
  const { mountNavigation } = await import('../js/navigation.js');
  const dom = new JSDOM('<body><div id="appShell"></div><main>Report</main></body>', { url:'https://reports.example.test/' });
  try {
    const host = mountNavigation(dom.window.document, '/', { report:true });
    assert.equal(host.querySelector('.app-shell-controls'), null);
    assert.equal(host.querySelector('#callModeAvailability'), null, 'reports carry no Call mode status');
    assert.equal(dom.window.document.body.classList.contains('report-shell'), true);
    assert.equal(host.querySelector('[aria-label="Leads"]').href, 'https://app.example.test/leads');
    const more = host.querySelector('[aria-label="More"]');
    const list = host.querySelector('.app-shell-more-list');
    more.click();
    assert.equal(list.hidden, false);
    assert.equal(more.getAttribute('aria-expanded'), 'true');
    host.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
    assert.equal(list.hidden, true);
    assert.equal(more.getAttribute('aria-expanded'), 'false');
    assert.equal(dom.window.document.activeElement, more);
    more.click();
    dom.window.document.querySelector('main').click();
    assert.equal(list.hidden, true);
  } finally { dom.window.close(); }
});

test('a report mounted on any origin drops partner controls and the Call mode status', async () => {
  const { JSDOM } = await import('jsdom');
  const { mountNavigation } = await import('../js/navigation.js');
  const dom = new JSDOM('<body><div id="appShell"></div><main>Report</main></body>', { url:'https://preview.example.test/share' });
  try {
    const host = mountNavigation(dom.window.document, '/share', { report:true });
    assert.equal(host.querySelector('.app-shell-controls'), null);
    assert.equal(dom.window.document.getElementById('callModeAvailability'), null, 'no Quill check runs on a report, so none is announced');
    assert.equal(dom.window.document.querySelector('.app-shell-call-availability'), null);
    assert.equal(host.querySelector('[aria-label="Leads"]').getAttribute('href'), '/leads', 'a same-origin report links within its origin');
  } finally { dom.window.close(); }
});

test('navigation has one public module; the app shell exports only app mounting', async () => {
  const shell = await import('../js/app-shell.js');
  assert.deepEqual(Object.keys(shell).sort(), ['mountAppShell', 'partnerIdentity']);
  const navigation = await import('../js/navigation.js');
  assert.deepEqual(Object.keys(navigation).sort(), ['activeDestination', 'appOriginForReport', 'appShellMarkup', 'mountNavigation', 'navigationItems']);
});
