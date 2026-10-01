import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { boardFreshness, boardDirectory } from "../js/progress-board-model.js";

const NOW = new Date("2026-10-01T15:00:00Z");
const boards = [
  { board_id: "demo-project", title: "Demo project", project: "demo-project", updated_at: "2026-09-29T14:00:00Z", task_counts: { running: 1, blocked: 1 } },
  { board_id: "carr-v5", title: "System progress", project: "carr-v5", updated_at: "2026-10-01T14:30:00Z", task_counts: { running: 1 } },
];

async function open(t, { width = 390, path = "/control-room/progress", directoryFails = false } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: "UTC" });
  page.setDefaultTimeout(5000);
  await page.clock.install({ time: NOW });
  const calls = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://localhost") return route.abort();
    if (url.pathname === "/mcp") {
      const rpc = route.request().postDataJSON(); calls.push(rpc.params);
      const listing = rpc.params.name === "list-progress-boards";
      const id = rpc.params.arguments.board_id;
      const board = boards.find(board => board.board_id === id);
      const payload = listing ? { ok: true, schema: "progress-board-directory.v1", boards }
        : rpc.params.name === "read-progress-board" ? { ok: true, snapshot: { board_id: id,
          version: 2, updated_at: board.updated_at, snapshot_json: { title: board.title,
            tasks: { build: { title: "Synthetic build", status: "running", updated_at: "2026-10-01T14:30:00Z" } } } }, questions: [] } : {};
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: {
        ...(listing && directoryFails ? { isError: true } : {}),
        content: [{ text: JSON.stringify(listing && directoryFails ? { error: "directory unavailable" } : payload) }],
      } }) });
    }
    if (url.pathname === "/app-release" || url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    const path = url.pathname === "/control-room/progress" || url.pathname === "/progress-board" ? "progress-board.html"
      : url.pathname === "/control-room" ? "control-room.html" : url.pathname.slice(1);
    try {
      const body = await readFile(new URL("../" + path, import.meta.url));
      return route.fulfill({ body, contentType: path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html" });
    } catch { return route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto(`http://localhost${path}`);
  return { page, calls, errors };
}

test("freshness has an exact 24h boundary and unknown timestamps never look fresh", () => {
  assert.equal(boardFreshness("2026-09-30T15:00:00Z", NOW).state, "stale");
  assert.equal(boardFreshness("2026-09-30T15:00:00.001Z", NOW).state, "fresh");
  assert.equal(boardFreshness("2026-09-30T15:00:00", NOW).state, "stale", "producer naive timestamps are UTC");
  for (const value of [null, "invalid", ""]) assert.equal(boardFreshness(value, NOW).state, "unknown");
  assert.deepEqual(boardDirectory({ schema: "progress-board-directory.v1", boards }).map(b => b.board_id), ["carr-v5", "demo-project"]);
});

test("desktop and phone main navigation reach Progress with one tap", async t => {
  for (const width of [1440, 390, 320]) await t.test(String(width), async t => {
    const { page, errors } = await open(t, { width, path: "/control-room" });
    const selector = width <= 900 ? ".app-shell-progress-shortcut" : '[data-app-nav-item][aria-label="Progress"]';
    assert.equal(await page.locator(selector).isVisible(), true);
    await page.locator(selector).click();
    await page.waitForURL("**/control-room/progress");
    await page.waitForFunction(() => document.querySelector("#board-title")?.textContent === "System progress");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  });
});

test("no-param load shows system board, counts, timestamps and stale project; selection opens it", async t => {
  const { page, calls, errors } = await open(t);
  await page.waitForFunction(() => document.querySelector("#board-title")?.textContent === "System progress");
  assert.equal(await page.locator(".board-link").first().getAttribute("data-board-id"), "carr-v5");
  const project = page.locator('[data-board-id="demo-project"]');
  assert.match(await project.textContent(), /1 running · 1 blocked/);
  assert.match(await project.locator("time").textContent(), /PM/);
  assert.match(await project.locator('[data-freshness="stale"]').textContent(), /2d 1h ago.*Stale.*24h/);
  assert.equal(calls.find(c => c.name === "read-progress-board").arguments.board_id, "carr-v5");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator(".flow-stage").count(), 6);
  await project.click();
  await page.waitForURL("**/control-room/progress?board=demo-project");
  await page.waitForFunction(() => document.querySelector("#board-title")?.textContent === "Demo project");
  assert.equal(await page.locator("#board-freshness").getAttribute("data-freshness"), "stale");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});

test("project deep links work on canonical and legacy routes even when discovery fails", async t => {
  for (const route of ["/control-room/progress", "/progress-board"]) await t.test(route, async t => {
    const { page, calls, errors } = await open(t, { path: `${route}?board=demo-project`, directoryFails: true });
    await page.waitForFunction(() => document.querySelector("#board-title")?.textContent === "Demo project");
    assert.equal(calls.find(c => c.name === "read-progress-board").arguments.board_id, "demo-project");
    assert.equal(await page.locator("#board-error").isVisible(), false);
    assert.equal(await page.locator("#directory-error").isVisible(), true);
    assert.deepEqual(errors, []);
  });
});

test("normal motion flows; reduced motion stops animation while preserving stale shape and task detail", async t => {
  const { page } = await open(t);
  await page.waitForFunction(() => document.querySelector(".pipeline-connector"));
  assert.equal(await page.locator(".pipeline-connector").first().evaluate(node => getComputedStyle(node).animationName), "flow");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const selector of [".pipeline-connector", ".node-halo", ".freshness-badge"])
    assert.equal(await page.locator(selector).first().evaluate(node => getComputedStyle(node, node.classList.contains("freshness-badge") ? "::before" : null).animationName), "none");
  assert.equal(await page.locator('[data-freshness="stale"]').first().evaluate(node => getComputedStyle(node, "::before").borderRadius), "1px");
  await page.locator(".pipeline-node").click();
  assert.equal(await page.locator("#task-detail").isVisible(), true);
  assert.match(await page.locator("#task-detail-title").textContent(), /Synthetic build/);
});
