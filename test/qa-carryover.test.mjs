// V1 QA carry-over from PR 180: QA-002, QA-005, QA-009, QA-016.
// QA-011 (multiple-match guidance) is already covered by search.test.mjs B05-10.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { mountLeadsWorkspace } from "../js/leads-workspace-app.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("QA-002 light Home overrides only the light text tokens, leaving the dark register alone", async () => {
  const css = await read("css/home-dashboard.css");
  const rule = css.match(/:root\[data-theme="light"\]\s+\.home-shell\s*\{([^}]*)\}/);
  assert.ok(rule, "light-theme rule for .home-shell exists");
  for (const token of ["--text", "--muted", "--quiet"]) assert.match(rule[1], new RegExp(`${token}:\\s*#[0-9a-f]{6}`, "i"), `${token} is set for light`);
  assert.doesNotMatch(rule[1], /background|--orange|--ground/, "light rule adjusts text tokens only");
  // Dark default is untouched: no unscoped token override on .home-shell.
  assert.doesNotMatch(css.replace(/:root\[data-theme="light"\][^{]*\{[^}]*\}/g, ""), /\.home-shell\s*\{[^}]*--(text|muted|quiet):/);
});

test("QA-005 phone drawers leave room under the floating Doc control", async () => {
  const css = await read("css/doc-presence.css");
  const phone = css.match(/@media\s*\(max-width:\s*760px\)\s*\{([^]*)\}\s*$/m);
  assert.ok(phone, "doc-presence.css has a phone block");
  assert.match(phone[1], /\.has-app-layout\s+\.app-layout-sidebar[^{]*\{[^}]*padding-bottom:\s*100px/);
  assert.match(phone[1], /\.app-layout-today[^{]*\{[^}]*padding-bottom:\s*100px|\.app-layout-today[^{]*,[^{]*\{[^}]*padding-bottom:\s*100px/);
});

test("QA-009 thread controls are disabled until a conversation is selected", async () => {
  const js = await read("js/conversations.js");
  const body = js.slice(js.indexOf("function renderAccess()"), js.indexOf("function renderList()"));
  assert.match(body, /for \(const id of \["renameInput", ?"renameSave", ?"pinToggle", ?"archiveToggle"\]\) \$\(id\)\.disabled = !header;/);
});

test("QA-016 the leads sign-in link returns to the current page, query included", async () => {
  const dom = new JSDOM(await read("leads.html"), { url: "https://example.test/leads?mode=live&stage=engaged", pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const denied = () => Object.assign(new Error("Sign-in required"), { code: "not_authenticated", status: 401 });
  const client = { getActor: async () => { throw denied(); }, getWorkspace: async () => { throw denied(); } };
  const app = mountLeadsWorkspace(d, client, { mapFactory: async () => ({ update() {}, dispose() {} }) });
  await app.refresh();
  try {
    const link = d.querySelector("#leadBoardError a");
    assert.ok(link, "a Sign in link is offered");
    assert.equal(link.getAttribute("href"), `/auth/login?return_to=${encodeURIComponent("/leads?mode=live&stage=engaged")}`);
  } finally { app.dispose(); dom.window.close(); }
});
