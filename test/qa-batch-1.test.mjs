// QA batch 1 — Conversations order, Search phone order, Home always returns to /,
// and Deal Room phone scroll regions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const at = (html, needle) => { const i = html.indexOf(needle); assert.ok(i >= 0, `missing ${needle}`); return i; };

test("Conversations puts the list before outcome cards and suggestions", async () => {
  const html = await read("conversations.html");
  assert.ok(at(html, 'data-section="list"') < at(html, 'data-section="outcome-cards"'));
  assert.ok(at(html, 'data-section="list"') < at(html, 'data-section="suggestions"'));
});

test("Conversations carries no no-thread or unknown-status copy in the hero", async () => {
  const html = await read("conversations.html");
  const js = await read("js/conversations.js");
  const hero = html.slice(at(html, 'data-section="hero"'), at(html, 'id="conversationLive"'));
  assert.doesNotMatch(hero, /No conversation is open|no conversation open|>unknown</i);
  assert.doesNotMatch(js, /No conversation is open|no conversation open/);
  for (const id of ["conversationId", "conversationAsOf", "visibilityBadge", "heroFacts", "titleHistoryLine"]) {
    assert.match(hero, new RegExp(`id="${id}"[^>]*hidden`), `${id} starts hidden`);
  }
  assert.match(js, /piece\.hidden = !header/);
});

test("Search puts candidates and results ahead of Scope and Saved views", async () => {
  const html = await read("search.html");
  for (const later of ['data-search="scope"', 'data-search="views"']) {
    assert.ok(at(html, 'id="searchCandidates"') < at(html, later), `candidates before ${later}`);
    assert.ok(at(html, 'id="searchResults"') < at(html, later), `results before ${later}`);
  }
});

test("no page or script points Home or sign-in at /business", async () => {
  for (const file of ["business-workspace.html", "js/business-workspace.js", "workspace.html", "js/workspace-command-center-model.js", "js/app-shell.js"]) {
    const src = await read(file);
    assert.doesNotMatch(src, /href="\/business|return_to=\/business|"\/business"\s*,\s*href/, `${file} must not target /business`);
  }
  const shell = await import("../js/app-shell.js");
  const markup = shell.appShellMarkup("/search");
  assert.match(markup, /aria-label="DoctorCRE Home"/);
  assert.match(markup, /class="app-shell-brand" href="\/"/);
  assert.match(markup, /aria-label="Home"[^>]*href="\/"/);
  assert.doesNotMatch(markup, /\/business/);
  assert.match(await read("js/business-workspace.js"), /SIGN_IN_HREF = "\/auth\/login\?return_to=%2F"/);
});

test("every Home page control resolves to a real route, never /business", async () => {
  const html = await read("workspace.html");
  const routes = JSON.parse(await read("contracts/app-routes.v1.json"));
  const targets = [...html.matchAll(/<a [^>]*href="(\/[^"?#]*)/g)].map((m) => m[1]);
  for (const target of targets) assert.ok(target === "/" || routes.routes[target] || routes.redirects[target] || target.startsWith("/auth/"), `${target} is a routed path`);
  assert.equal(routes.redirects["/business"], "/");
});

test("Deal Room phone strips scroll in their own regions with dark scrollbars", async () => {
  const css = await read("css/app.css");
  const shell = await read("css/app-shell.css");
  assert.match(css, /\.focus,\.filters,\.table-frame[^{]*\{[^}]*max-width:100%[^}]*overscroll-behavior-x:contain[^}]*scrollbar-color:#3a5878 #0a1a2e/);
  assert.match(css, /\.focus::-webkit-scrollbar-thumb[^{]*\{[^}]*background:#3a5878/);
  assert.match(css, /\.focus\{[^}]*overflow:auto/);
  assert.match(css, /\.filters\{[^}]*overflow:auto/);
  assert.match(css, /@media\(max-width:680px\)\{html,body\{max-width:100%;overflow-x:clip\}/);
  assert.match(shell, /@media\(max-width:900px\)\{\.app-shell-navigation\{max-height:calc\(100vh - 120px\);overflow:auto/);
  assert.match(shell, /\.app-shell-navigation::-webkit-scrollbar-thumb/);
});

test("Search on a phone caps the candidate list inside its own scroll region", async () => {
  const css = await read("css/business-workspace.css");
  const phone = css.slice(css.lastIndexOf("QA batch 1"));
  assert.match(phone, /#searchCandidates > \.work-list \{[^}]*max-height:[^}]*overflow-y: auto[^}]*scrollbar-color: var\(--line-strong\) transparent/);
  assert.match(phone, /#searchState\[data-state\^="disamb"\] \{ display: none; \}/);
});
