import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { mountLeadsWorkspace } from "../js/leads-workspace-app.js";
import { chromium } from "./browser-harness.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("QA-002 Home takes text colour from the theme tokens, with no per-theme hex overrides", async () => {
  const css = await read("css/home-dashboard.css");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "home-dashboard.css carries no raw hex");
  assert.doesNotMatch(css, /:root\[data-theme="light"\]\s+\.home-shell/, "no light-only .home-shell override");
  assert.doesNotMatch(css, /\.home-shell\s*\{[^}]*--(text|muted|quiet|fg)[\w-]*:/, ".home-shell does not redefine text tokens");
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
