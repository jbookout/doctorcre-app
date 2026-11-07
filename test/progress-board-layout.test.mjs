import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
// Real layout, real browser: at phone (390px) and desktop widths no card
// content may overflow its card, and the page never scrolls sideways. The
// real page and code run against a local server whose /mcp answers with the
// synthetic fixture; nothing in production code knows about this test.
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { startFixture } from '../scripts/fixture-http.mjs';
import { appAssetSnapshot } from '../scripts/fixture-app-assets.mjs';
import { join } from "node:path";
import test from "node:test";
import { chromium } from "./browser-harness.mjs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FULL = JSON.parse(await readFile(join(ROOT, "test/fixtures/progress-board-full.json"), "utf8"));

const MEASURE = `
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
for (let i = 0; i < 200 && !(document.querySelector("#board-stages .board-card") && document.querySelector(".app-shell-doc")); i += 1)
  await wait(25);
document.querySelector("#live-toggle")?.click();
await wait(50);
const problems = [];
const cards = [...document.querySelectorAll(".board-card, .blocked-card, .completed-card, .ledger-row, .question-card")];
for (const card of cards) {
  const box = card.getBoundingClientRect();
  const name = card.dataset.cardId || card.className;
  if (card.scrollWidth > card.clientWidth + 1) problems.push(name + ": scrollWidth " + card.scrollWidth + " > clientWidth " + card.clientWidth);
  for (const child of card.querySelectorAll("*")) {
    const rect = child.getBoundingClientRect();
    if (!rect.width) continue;
    if (rect.right > box.right + 1 || rect.left < box.left - 1)
      problems.push(name + ": ." + (child.className || child.tagName) + " spills outside its card");
  }
}
for (const model of document.querySelectorAll(".card-model")) {
  const style = getComputedStyle(model);
  if (style.textOverflow !== "ellipsis" || style.whiteSpace !== "nowrap") problems.push("model line is not a one-line ellipsis");
  if (!model.title) problems.push("model line has no title");
}
// PR identifiers are never clipped: the repository name and the number stay readable.
for (const label of document.querySelectorAll(".board-card .card-pr, .blocked-card .card-pr, .completed-card .card-pr")) {
  const owner = label.closest("[data-card-id]")?.dataset.cardId || "card";
  if (label.scrollWidth > label.clientWidth + 1)
    problems.push(owner + ": PR label clipped (" + label.clientWidth + " < " + label.scrollWidth + ")");
}
// Every control is the thing a tap at its centre reaches, with the app shell mounted.
for (const control of document.querySelectorAll("#legend-toggle, .app-shell-doc:not([hidden])")) {
  // In the Control Room the Key sits in the board toolbar, so bring it on screen first.
  control.scrollIntoView({ block: "center" });
  const rect = control.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const target = hit?.closest("a, button");
  if (target !== control) problems.push((control.id || control.className) + ": a centre tap reaches " + (target?.id || target?.className || hit?.tagName));
}
const page = document.documentElement;
if (page.scrollWidth > innerWidth + 1) problems.push("page scrolls sideways: " + page.scrollWidth + " > " + innerWidth);
// Open the real Key: presence checks cannot catch a sample obscuring its explanation.
document.querySelector("#legend-toggle").click();
await wait(300);
const entries = [...document.querySelectorAll(".legend-entry")];
if (!entries.some(entry => entry.dataset.legendId === "flag-unrefreshed"))
  problems.push("outage legend entry missing");
for (const entry of entries) {
  entry.scrollIntoView({ block: "nearest" });
  const sample = entry.querySelector(".legend-sample > *").getBoundingClientRect();
  const column = entry.querySelector(".legend-sample").getBoundingClientRect();
  const explanation = entry.querySelector("dd").getBoundingClientRect();
  if (sample.left < column.left - 1 || sample.right > column.right + 1 || sample.right > explanation.left)
    problems.push(entry.dataset.legendId + ": legend sample spills outside its column");
  const range = document.createRange();
  range.selectNodeContents(entry.querySelector("dd"));
  const textLines = [...range.getClientRects()];
  if (!sample.width || !textLines.some(line => line.width)) {
    problems.push(entry.dataset.legendId + ": sample or explanation not visible");
    continue;
  }
  if (textLines.some(line => sample.right > line.left + 1 && sample.left < line.right - 1
      && sample.bottom > line.top + 1 && sample.top < line.bottom - 1))
    problems.push(entry.dataset.legendId + ": legend sample overlaps explanation");
}
if (page.scrollWidth > innerWidth + 1) problems.push("open Key makes the page scroll sideways");
parent.document.body.setAttribute("data-measure", JSON.stringify({ cards: cards.length, legendEntries: entries.length, width: innerWidth, problems }));
`;

function withoutScripts(html) {
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    for (const script of document.querySelectorAll('script')) script.remove();
    assert.equal(document.scripts.length, 0);
    return document.documentElement.outerHTML;
  } finally { dom.window.close(); }
}

for (const html of ['<script>throw Error(1)</script>', '<SCRIPT>throw Error(1)</SCRIPT>',
  '<script type="module" src="/app.js"></script>', '<scr<script>ipt>text</scr</script>ipt>']) {
  test(`layout shell removes parsed script elements: ${html}`, () => {
    const dom = new JSDOM(withoutScripts(html));
    try { assert.equal(dom.window.document.scripts.length, 0); }
    finally { dom.window.close(); }
  });
}

async function serve() {
  const assets = await appAssetSnapshot();
  const shell = assets.get('/control-room.html');
  assets.set('/progress-board', { ...shell,
    body: Buffer.from(String(shell.body).replace('</body>', '<script type="module" src="/__measure.js"></script></body>')) });
  assets.set('/__measure.js', { body: MEASURE, contentType: 'text/javascript' });
  const session = { body: JSON.stringify({actor:{slug:'joe'},csrf_token:'synthetic-session'}), contentType:'application/json' };
  return startFixture({ assets, routes:new Map([['/auth/session',session],['/api/system-work/session',session]]) });
}

for (const width of [390, 1280]) {
  for (const board of ["demo-project", "all-repos"]) {
    test(`cards and open Key have no clipping or overlap at ${width}px on ${board}`, async t => {
      const server = await serve();
      t.after(() => server.close());
      const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.route('**/mcp', async route => {
        const { params } = route.request().postDataJSON();
        const read = params?.name === 'read-progress-board'
          ? (params.arguments?.board_id === 'all-repos' ? FULL.all_repos : FULL.project) : {};
        await route.fulfill({ contentType:'application/json', body:JSON.stringify({result:{content:[{text:JSON.stringify({ok:true,...read})}]}}) });
      });
      await page.goto(`${server.origin}/progress-board?board=${board}&mode=live&tab=boards`);
      await page.waitForFunction(() => document.body.hasAttribute("data-measure"));
      const result = await page.evaluate(() => JSON.parse(document.body.getAttribute("data-measure")));
      assert.equal(result.width, width);
      assert.ok(result.cards > 10, `cards rendered: ${result.cards}`);
      assert.ok(result.legendEntries > 0, "the open Key rendered its explanations");
      assert.deepEqual(result.problems, []);
    });
  }
}

for (const width of [1440, 390]) test(`Live expansion keeps browser focus through background updates at ${width}px`, async t => {
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 960 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  // Mount the production board directly, with synthetic reads and no external effects.
  const assets = await appAssetSnapshot();
  const shell = assets.get('/control-room.html');
  assets.set('/', { ...shell, body: Buffer.from(withoutScripts(String(shell.body))) });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://board.test') return route.abort();
    const asset = assets.get(url.pathname);
    if (!asset) return route.fulfill({status:404,body:''});
    await route.fulfill({body:asset.body,contentType:asset.contentType});
  });
  await page.goto("http://board.test/");
  await page.evaluate(async read => {
    const { mountBoard } = await import("/js/progress-board.js");
    window.focusRead = read;
    window.focusBoard = mountBoard({ window, document, storage: null, search: "?board=focus-demo",
      client: { readProgressBoard: async () => structuredClone(window.focusRead) },
      now: () => new Date("2026-09-30T12:00:00Z"), setInterval: () => 0,
      setTimeout: () => 0, clearTimeout: () => {} });
    await window.focusBoard.refresh();
  }, FULL.project);
  const toggle = page.locator("#live-toggle");
  for (const expanded of [false, true]) {
    if (expanded) await toggle.click();
    for (const update of ["tick", "refresh"]) {
      await toggle.focus();
      await page.evaluate(async update => { await window.focusBoard[update](); }, update);
      assert.equal(await toggle.evaluate(node => node === document.activeElement), true, `${update}, expanded=${expanded}`);
      assert.equal(await toggle.getAttribute("aria-expanded"), String(expanded));
      const outside = page.locator("#board-retry");
      await outside.focus();
      await page.evaluate(async update => { await window.focusBoard[update](); }, update);
      assert.equal(await outside.evaluate(node => node === document.activeElement), true);
    }
  }
  await toggle.focus();
  await page.evaluate(async () => {
    window.focusRead.snapshot.snapshot_json.tasks = {};
    await window.focusBoard.refresh();
  });
  assert.equal(await toggle.count(), 0);
  assert.equal(await page.locator("#board-title").evaluate(node => node === document.activeElement), true);
  assert.deepEqual(errors, []);
});
