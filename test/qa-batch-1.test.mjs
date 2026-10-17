

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

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
  for (const file of ["workspace.html", "js/workspace-command-center-model.js", "js/app-shell.js"]) {
    const src = await read(file);
    assert.doesNotMatch(src, /href="\/business|return_to=\/business|"\/business"\s*,\s*href/, `${file} must not target /business`);
  }
  const shell = await import("../js/navigation.js");
  const markup = shell.appShellMarkup("/search");
  assert.match(markup, /aria-label="DoctorCRE Home"/);
  assert.match(markup, /class="app-shell-brand" href="\/"/);
  assert.match(markup, /aria-label="Home"[^>]*href="\/"/);
  assert.doesNotMatch(markup, /\/business/);
});

test("every Home page control resolves to a real route, never /business", async () => {
  const html = await read("workspace.html");
  const routes = (await import("../js/routes.js")).routeContract;
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
  assert.match(shell, /\.app-shell-more-list[^}]*max-height:calc\(100dvh - 125px\)/);
  assert.match(shell, /scrollbar-color:#3a5878 #0a1a2e/);
});

test("Search on a phone caps the candidate list inside its own scroll region", async () => {
  const css = await read("css/business-workspace.css");
  const dom = new JSDOM("<!doctype html><style></style>");
  try {
    const { document } = dom.window;
    document.querySelector("style").textContent = css;
    const phoneRules = [...document.styleSheets[0].cssRules]
      .filter((rule) => rule.media?.mediaText === "(max-width: 640px)")
      .flatMap((rule) => [...rule.cssRules]);
    const list = phoneRules.find((rule) => rule.selectorText === "#searchCandidates > .work-list");
    assert.ok(list, "candidate scroll rule exists inside the phone media query");
    assert.equal(list.style.getPropertyValue("max-height"), "min(30vh, 220px)");
    assert.equal(list.style.getPropertyValue("overflow-y"), "auto");
    assert.equal(list.style.getPropertyValue("overscroll-behavior"), "contain");
    assert.equal(list.style.getPropertyValue("scrollbar-width"), "thin");
    assert.equal(list.style.getPropertyValue("scrollbar-color"), "var(--line-strong) transparent");
    const state = phoneRules.find((rule) => rule.selectorText === '#searchState[data-state^="disamb"]');
    assert.ok(state, "disambiguation notice rule exists inside the phone media query");
    assert.equal(state.style.getPropertyValue("display"), "none");
  } finally {
    dom.window.close();
  }
});
