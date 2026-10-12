// V1 QA carry-over from PR 180: QA-002, QA-005, QA-009, QA-016.
// QA-011 (multiple-match guidance) is already covered by search.test.mjs B05-10.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { mountLeadsWorkspace } from "../js/leads-workspace-app.js";
import { chromium } from "./browser-harness.mjs";
import { TOUCH_LAYOUT } from "../js/touch-layout.js";

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

test("QA-002 light Home calendar tiles keep weekday and date text at 4.5:1", async () => {
  // Render the Home page's own stylesheets, in page order, around the calendar markup.
  const sheets = [...(await read("workspace.html")).matchAll(/<link rel="stylesheet" href="\/(css\/[^"]+)">/g)].map((match) => match[1]);
  const css = (await Promise.all(sheets.map(read))).join("\n");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html data-theme="light"><head><style>${css}</style></head><body><main class="shell home-shell"><section class="home-panel glass"><div class="home-week"><div class="home-day"><span>Mon</span><strong>28</strong></div><div class="home-day today"><span>Tue</span><strong>29</strong></div></div></section></main></body></html>`);
    const ratios = await page.evaluate(() => {
      const rgba = (value) => value.match(/[\d.]+/g).map(Number);
      const over = ([r, g, b, a = 1], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
      const fill = (element) => element ? over(rgba(getComputedStyle(element).backgroundColor), fill(element.parentElement)) : [255, 255, 255];
      const luminance = (rgb) => rgb.map((c) => c / 255).map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
      return [...document.querySelectorAll(".home-day")].flatMap((day) => ["span", "strong"].map((tag) => ({ text: day.querySelector(tag).textContent, ratio: ratio(rgba(getComputedStyle(day.querySelector(tag)).color), fill(day)) })));
    });
    for (const { text, ratio } of ratios) assert.ok(ratio >= 4.5, `${text} contrast ${ratio.toFixed(2)}:1`);
  } finally { await browser.close(); }
});

test("QA-005 phone drawers leave room under the floating Doc control", async () => {
  const css = await read("css/doc-presence.css");
  // Drawers open on phones and touch tablets, so the room follows the shared touch query.
  const start = css.lastIndexOf(`@media${TOUCH_LAYOUT}{`);
  assert.ok(start >= 0, "doc-presence.css has a touch-layout block");
  const touch = css.slice(start);
  assert.match(touch, /\.has-app-layout\s+\.app-layout-sidebar[^{]*\{[^}]*padding-bottom:\s*100px/);
  assert.match(touch, /\.app-layout-today[^{]*\{[^}]*padding-bottom:\s*100px|\.app-layout-today[^{]*,[^{]*\{[^}]*padding-bottom:\s*100px/);
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
