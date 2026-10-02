import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { appShellMarkup, navigationItems } from "../js/app-shell.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * What a reader can actually see, for the copy checks below. A comment
 * promising not to make a claim is not the claim, and asserting against
 * comments is how a truthful file fails a truthfulness test.
 */
const withoutComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|\s)\/\/.*$/gm, "$1");

test("Home uses self-explanatory scope names and removes repeated navigation and aggregate widgets", async () => {
  const html = await readFile(`${ROOT}/workspace.html`, "utf8");
  assert.match(html, /data-scope="team"[^>]*aria-pressed="true">Team View/);
  assert.match(html, /data-scope="mine"[^>]*aria-pressed="false">Just Me/);
  assert.doesNotMatch(html, /scopeNote|module-card|workspace-directory|commandCenterVisual|docAtWork|needsYouNow|recentActivity|view=charts|density|class="intro"/);
  assert.match(html, /id="homePrimaryAction" class="home-outline" href="\/deals">Deal Room/);
  assert.match(html, /Active Deals: —/);
  assert.match(html, /Deals in Market: —/);
  assert.match(html, /National Account Deals: —/);
  assert.match(html, /id="refreshHome"/);
  assert.match(html, /id="observedAt"/);
  assert.doesNotMatch(html, /class="source"|Read again|retry read/);
});

test("Home ships cinematic visual widgets, wide detail and phone/reduced-motion styles", async () => {
  const css = await readFile(`${ROOT}/css/home-dashboard.css`, "utf8");
  const js = await readFile(`${ROOT}/js/workspace-command-center.js`, "utf8");
  const html = await readFile(`${ROOT}/workspace.html`, "utf8");
  assert.match(css, /max-width:none/);
  assert.match(css, /backdrop-filter/);
  assert.match(css, /@media\(max-width:767px\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /width:min\(1000px/);
  assert.match(js, /home-week/);
  assert.match(js, /home-lead-scores/);
  assert.match(js, /home-radar/);
  assert.match(js, /mountAutoRefresh/);
  assert.match(js, /epoch !== sequence/);
  assert.match(js, /innerSignal.aborted/);
  assert.match(html, /<dialog id="homeDetail"/);
  assert.match(js, /<summary(?:\s[^>]*)?>Details<\/summary>/);
});

test("all authenticated surfaces mount the approved shared navigation", async () => {
  const routes = JSON.parse(await readFile(`${ROOT}/contracts/app-routes.v1.json`, "utf8"));
  for (const [route, file] of Object.entries(routes.routes)) {
    if (file === "reports/share.html") continue;
    const html = await readFile(`${ROOT}/${file}`, "utf8");
    assert.match(html, /id="appShell"/, `${route}: shared shell mount`);
    const nav = appShellMarkup(route);
    assert.equal((nav.match(/data-app-nav-item/g) || []).length, navigationItems.length, `${route}: same destinations`);
  }
  assert.deepEqual(navigationItems.filter(item => !item.group).map(({ label }) => label),
    ["Home", "Leads", "Tours", "Local Deals", "Vendors", "Control Room"]);
});

test("People offers both directories in the shared shell", () => {
  assert.match(appShellMarkup("/clients"), /href="\/clients" aria-current="page">Clients<\/a>/);
  assert.match(appShellMarkup("/vendors"), /href="\/vendors" aria-current="page">.*?Vendors<\/span><\/a>/);
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
  assert.match(nav, /href="\/doc-chats" aria-label="Doc"/);
});

test("no page links to the removed Meeting page and the route is gone", async () => {
  const { readdir } = await import("node:fs/promises");
  const pages = (await readdir(ROOT)).filter((name) => name.endsWith(".html"));
  assert.ok(pages.includes("workspace.html"));
  assert.equal(pages.includes("meeting.html"), false, "meeting.html is removed");
  for (const file of pages) {
    const html = await readFile(`${ROOT}/${file}`, "utf8");
    assert.doesNotMatch(html, /href="\/meeting/, `${file} still links to /meeting`);
    assert.doesNotMatch(html, /<h2>Meeting<\/h2>/, `${file} still carries a Meeting card`);
  }
  const routes = JSON.parse(await readFile(`${ROOT}/contracts/app-routes.v1.json`, "utf8"));
  assert.equal(routes.routes["/meeting"], undefined);
  const contract = JSON.parse(await readFile(`${ROOT}/contracts/carr-interface.v1.json`, "utf8"));
  assert.deepEqual(contract.mcp_operations.filter((verb) => /meeting/.test(verb)), [],
    "the app no longer consumes any meeting verb");
});

test("Home and People mount the same phone menu", async () => {
  for (const file of ["workspace.html", "business.html"]) {
    const html = await readFile(`${ROOT}/${file}`, "utf8");
    assert.match(html, /id="appShell"/, file);
    assert.match(html, /src="\/js\/app-shell\.js"/, file);
  }
  assert.match(appShellMarkup("/"), /href="\/work-requests"[^>]*>Work Requests<\/a>/);
});

test("Clients and Vendors is a real read journey with distinguishable states", async () => {
  const html = await readFile(`${ROOT}/business.html`, "utf8");
  const js = await readFile(`${ROOT}/js/workspace-business.js`, "utf8");
  const modelJs = await readFile(`${ROOT}/js/workspace-business-model.js`, "utf8");
  const css = await readFile(`${ROOT}/css/workspace-business.css`, "utf8");
  // Server-side search, filter, sort, scope and paging — all real controls.
  assert.match(html, /id="searchInput"[^>]*maxlength="80"/);
  assert.match(html, /id="filterA"/);
  assert.match(html, /id="filterB"/);
  assert.match(html, /id="filterC"/);
  assert.match(html, /id="sortSelect"/);
  assert.match(html, /id="scopeSwitch"[^>]*role="group"[^>]*aria-label="Record scope"/);
  assert.match(html, /data-scope="team"[^>]*aria-pressed="true"/);
  assert.match(html, /data-scope="mine"[^>]*aria-pressed="false"/);
  assert.match(html, /id="pager"/);
  assert.match(html, /id="recordPanel"/);
  assert.match(html, /id="recordClose"/);
  assert.match(html, /id="noticeRegion"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="recordTitle" tabindex="-1"/);
  // The read is the server's; nothing is seeded, faked or counted here.
  assert.match(js, /const key = listRequestUrl\(query\)/);
  assert.match(js, /fetchRead\(recordRequestUrl\(view\.dataset, id\)/);
  assert.match(modelJs, /API_PREFIX = "\/api\/v1\/business\/"/);
  assert.doesNotMatch(js, /const (rows|records|seed|fixture|sampleData)\s*=\s*\[/);
  assert.doesNotMatch(js, /Math\.random/);
  assert.doesNotMatch(modelJs, /total:\s*[a-z]*rows\.length/i);
  assert.match(modelJs, /const total = payload\.total/);
  // Read-only: no method, no body, no CSRF-bearing write leaves this surface.
  assert.doesNotMatch(js, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(js, /x-carr-csrf|body:\s*JSON\.stringify/);
  // No operational logging or engineering detail in a business surface.
  assert.doesNotMatch(js, /console\.(log|warn|error|debug)/);
  assert.doesNotMatch(js, /DATABASE_URL|Authorization|Bearer |token/i);
  // Loading, refreshing, stale, both empties, past-the-end, unauthorized and
  // unavailable are distinct, and a late answer cannot paint over a newer one.
  assert.match(modelJs, /export function listPhase/);
  assert.match(modelJs, /"empty-no-matches"/);
  assert.match(modelJs, /"empty-no-records"/);
  assert.match(modelJs, /"out-of-range"/);
  assert.match(modelJs, /export function echoesQuery/);
  assert.match(js, /acceptsResponse\(view\.list\.sequence, sequence\)/);
  assert.match(js, /!echoesQuery\(payload, query\)/);
  assert.match(js, /\+\+view\.list\.sequence/);
  assert.match(js, /setInterval/);
  assert.match(js, /freshnessSignature/);
  // A known sign-out clears every held answer rather than leaving the open
  // record on screen, and the remembered answers are read through one door that
  // refuses to open once signed out.
  assert.match(modelJs, /export function expireSession/);
  assert.match(modelJs, /export function cachedPayload/);
  assert.match(modelJs, /export function isSessionExpiry/);
  assert.match(js, /if \(response\.status === 401\) return expireNow\(\)/);
  assert.match(js, /isSessionExpiry\(response\.status, failure\.error\)/);
  assert.match(js, /Object\.assign\(view, expireSession\(view\)\)/);
  assert.match(js, /cachedPayload\(view, key\)/);
  assert.doesNotMatch(js, /listCache\.get\(/, "there is no second door onto the remembered answers");
  // Nullable stays unknown; a stored code without a name stays the code.
  assert.match(modelJs, /NOT_RECORDED = "Not recorded"/);
  assert.match(modelJs, /export function recordedCode/);
  // Status is never presented as a completed agreement or an assignment. The
  // check reads what a person can actually SEE — comments are stripped first,
  // because a comment promising not to make a claim is not the claim — and it
  // covers the page and the view as well as the model.
  const readerFacing = [html, withoutComments(js), withoutComments(modelJs)];
  for (const surface of readerFacing) {
    assert.doesNotMatch(surface, /signed ETL|accepted representation|assignment created|representation agreement in place/i);
    assert.doesNotMatch(surface, /book of record|lookup table|read model|canonical|v5 lifecycle/i);
  }
  // The three pipeline answers are the three the status list can give.
  assert.match(modelJs, /In the active pipeline/);
  assert.match(modelJs, /Not in the active pipeline/);
  assert.match(modelJs, /Pipeline not set/);
  assert.match(modelJs, /PIPELINE_FILTERS = \["any", "active", "other", "unknown"\]/);
  // Labels carry the status; the list needs no provenance instructions.
  assert.doesNotMatch(html, /not proof that an agreement was signed|Every list says where it came from/);
  assert.match(modelJs, /Not recorded/);
  // Keyboard, touch and reduced motion.
  assert.match(js, /event\.key !== "Escape"/);
  assert.match(js, /ArrowLeft/);
  assert.match(js, /ArrowRight/);
  assert.match(js, /popstate/);
  assert.match(js, /scrollY/);
  // Every focus move in this view is a focus move only: the scroll position is
  // restored deliberately, once, after them.
  assert.match(js, /function focusWithoutScrolling/);
  assert.match(js, /focus\?\.\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(js, /\.focus\(\)/, "no bare focus call is left to scroll the list");
  assert.match(js, /scrollIntent\(view\.query, href\)/);
  assert.match(js, /window\.scrollTo\(\{ top: restoreScroll/);
  // The address is rewritten to the state actually being shown.
  assert.match(js, /const wantedHref = viewHref\(parsed\.query, parsed\.recordId\)/);
  assert.match(js, /if \(wantedHref !== currentHref\(\)\)/);
  // The search box is reconciled by location, not by a finished read.
  assert.match(js, /searchBoxValue\(\{/);
  assert.match(js, /renderControls\(\{ syncSearch: true \}\)/);
  // The phone panel is a dialog with an inert background and contained focus.
  assert.match(js, /panelModality\(\{ recordId: view\.recordId, phoneWidth/);
  assert.match(js, /matchMedia\("\(max-width: 767px\)"\)/);
  assert.match(js, /setAttribute\("role", modal \? "dialog" : "complementary"\)/);
  assert.match(js, /setAttribute\("aria-modal", "true"\)/);
  assert.match(js, /region\.inert = modal/);
  assert.match(js, /function containPanelFocus/);
  // Every position is decided, including the heading the panel opens on, which
  // is inside the dialog but is not one of the tab stops.
  assert.match(modelJs, /export function panelTabTarget/);
  assert.match(js, /stopIndex: stops\.indexOf\(active\)/);
  assert.match(js, /if \(!target\) return;\n {2}event\.preventDefault\(\);/);
  // The width the script calls modal is the width the stylesheet makes
  // full-screen; if one moves without the other the containment stops matching
  // what is actually covering the list.
  assert.match(css, /@media\(max-width:767px\)[\s\S]*\.record-panel\.open\{position:fixed/);
  assert.match(html, /data-panel-background/);
  assert.match(html, /<aside class="record-panel glass" id="recordPanel" role="complementary"/);
  assert.doesNotMatch(html, /<aside[^>]*data-panel-background/, "the panel is never inert against itself");
  // The sign-out is heard even when the answer that carried it is stale — in
  // BOTH reads, pinned separately, because the record path is the one this
  // correction was made for and the two bodies are otherwise indistinguishable
  // to a document-wide regex.
  const bodyOf = (name) => js.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}`))?.[0] || "";
  for (const name of ["loadList", "loadRecord"]) {
    const body = bodyOf(name);
    assert.notEqual(body, "", `${name} body not found`);
    assert.match(body, /if \(response\.status === 401\) return expireNow\(\);\n {4}if \(!response\.ok\)/, name);
    // The guards still stand between a stale answer and the screen; they just
    // no longer stand in front of the sign-out. Measured from the fetch, since
    // loadRecord's settle closure mentions the guard earlier in the source.
    const afterFetch = body.slice(body.indexOf("const response = await fetch"));
    assert.ok(afterFetch.indexOf("expireNow()") > -1 && afterFetch.indexOf("acceptsResponse(") > -1);
    assert.ok(afterFetch.indexOf("expireNow()") < afterFetch.indexOf("acceptsResponse("), `${name} expiry precedes its guard`);
  }
  assert.match(bodyOf("loadRecord"), /view\.recordId !== id/);
  // The partial count is records, and the sentence says records.
  assert.match(js, /"record uses a code" : "records use codes"/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /\.record-row\{[^}]*min-height:44px/);
  assert.match(css, /\.field input,\.field select\{[^}]*min-height:44px/);
  assert.match(css, /\.panel-close\{[^}]*min-height:44px/);
  assert.match(css, /@media\(max-width:767px\)/);
  // Calls is visible as unavailable and cannot be started here; Tours is a
  // real, reachable surface and must not be marked inert.
  assert.match(html, /class="inert-entry" aria-disabled="true">Calls</);
  assert.doesNotMatch(html, /class="inert-entry" aria-disabled="true">Tours</);
  assert.doesNotMatch(html, /href="[^"]*"[^>]*>Calls</);
  assert.match(appShellMarkup("/clients"), /href="\/tours">.*?Tours<\/span><\/a>/);
});

test("mobile Home navigation replaces desktop navigation without occluding content", async () => {
  const css = await readFile(`${ROOT}/css/app-shell.css`, "utf8");
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /\.app-shell-navigation\{flex-direction:row;justify-content:space-around/);
  assert.match(css, /max-height:calc\(100dvh - 125px\)/);
});
