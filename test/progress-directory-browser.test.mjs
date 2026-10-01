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

async function open(t, { width = 390, path = "/control-room/progress", directoryFails = false, onRpc } = {}) {
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
      if (onRpc && await onRpc(route, rpc.params)) return;
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

function holdRequests(t, name) {
  const pending = [];
  t.after(async () => { for (const request of pending) request.release(); });
  return {
    pending,
    onRpc: async (route, rpc) => {
      if (rpc.name !== name) return false;
      await new Promise(resolve => pending.push({ route, release: resolve }));
      await route.abort().catch(() => {});
      return true;
    },
  };
}

test("ready project boards render while discovery stays pending on both deep links", async t => {
  for (const path of ["/control-room/progress", "/progress-board"]) await t.test(path, async t => {
    const held = holdRequests(t, "list-progress-boards");
    const { page } = await open(t, { path: `${path}?board=demo-project`, onRpc: held.onRpc });
    await page.waitForFunction(() => document.querySelector("#board-title").textContent === "Demo project");
    assert.ok(held.pending.length);
    assert.equal(await page.locator("#board-error").isVisible(), false);
    await page.clock.runFor(10001);
    await page.waitForFunction(() => !document.querySelector("#directory-error").hidden);
    assert.equal(await page.locator("#board-title").textContent(), "Demo project");
  });
});

test("ready directory renders while the selected board stays pending, then reports its deadline", async t => {
  const held = holdRequests(t, "read-progress-board");
  const { page } = await open(t, { onRpc: held.onRpc });
  await page.waitForFunction(() => document.querySelectorAll(".board-link").length === 2);
  assert.ok(held.pending.length);
  await page.clock.runFor(10001);
  await page.waitForFunction(() => !document.querySelector("#board-error").hidden);
  assert.equal(await page.locator(".board-link").count(), 2);
});

function snapshot(version = 1, status = null) {
  return { ok: true, snapshot: { board_id: "carr-v5", version, updated_at: "2026-10-01T14:30:00Z",
    snapshot_json: { title: `System version ${version}`, tasks: {} } },
    questions: [{ question_id: "decision", revision: 1, prompt: "Choose next step", choices: [],
      allow_free_text: true, status, answer_text: status ? "Ship it" : null }] };
}
function listing(title) {
  return { ok: true, schema: "progress-board-directory.v1", boards: [{ ...boards[1], title }] };
}
function controlledReads(t) {
  const requests = { "read-progress-board": [], "list-progress-boards": [] };
  const onRpc = async (route, rpc) => {
    if (rpc.name === "answer-board-question") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: {
        content: [{ text: JSON.stringify({ ok: true }) }],
      } }) });
      return true;
    }
    if (!requests[rpc.name]) return false;
    const response = await new Promise(resolve => requests[rpc.name].push({ route, resolve }));
    if (!response) { await route.abort().catch(() => {}); return true; }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: {
      ...(response.failed ? { isError: true } : {}), content: [{ text: JSON.stringify(response.payload) }],
    } }) }).catch(() => {});
    return true;
  };
  t.after(() => { for (const queue of Object.values(requests)) for (const request of queue) request.resolve(null); });
  return {
    onRpc,
    async request(name, index) {
      for (let attempts = 0; !requests[name][index] && attempts < 500; attempts++)
        await new Promise(resolve => setTimeout(resolve, 2));
      assert.ok(requests[name][index], `${name} request ${index} started`);
      return requests[name][index];
    },
    async reply(page, name, index, payload, failed = false) {
      const request = await this.request(name, index);
      const received = page.waitForResponse(response => response.request() === request.route.request());
      request.resolve({ payload, failed });
      const response = await received;
      await response.finished();
      await page.clock.runFor(1);
    },
  };
}

for (const failed of [false, true]) test(`answer refresh supersedes an older poll's ${failed ? "failures" : "successes"}`, async t => {
  const reads = controlledReads(t);
  const { page, errors } = await open(t, { onRpc: reads.onRpc });
  await reads.reply(page, "list-progress-boards", 0, listing("Initial directory"));
  await reads.reply(page, "read-progress-board", 0, snapshot());
  await page.waitForFunction(() => document.querySelector("#board-title").textContent === "System version 1");
  await page.clock.runFor(15000);
  await reads.request("read-progress-board", 1);
  await page.locator(".answer-form textarea").fill("Ship it");
  await page.locator('.answer-form button[type="submit"]').click();
  await reads.reply(page, "read-progress-board", 2, snapshot(2, "Sent"));
  await reads.reply(page, "list-progress-boards", 2, listing("New directory"));
  await page.waitForFunction(() => document.querySelector("#board-title").textContent === "System version 2");
  const old = failed ? { error: "old request failed" } : snapshot();
  await reads.reply(page, "read-progress-board", 1, old, failed);
  await reads.reply(page, "list-progress-boards", 1, failed ? old : listing("Old directory"), failed);
  assert.equal(await page.locator("#board-title").textContent(), "System version 2");
  assert.equal(await page.locator(".board-link h3").textContent(), "New directory");
  assert.equal(await page.locator(".question-card .status").textContent(), "Sent");
  assert.equal(await page.locator(".answer-form").count(), 0);
  assert.equal(await page.locator("#board-error").isVisible(), false);
  assert.equal(await page.locator("#directory-error").isVisible(), false);
  assert.deepEqual(errors, []);
});

test("an unchanged polled question retains its draft while focused questions defer polling", async t => {
  const reads = controlledReads(t);
  const { page, calls } = await open(t, { onRpc: reads.onRpc });
  await reads.reply(page, "list-progress-boards", 0, listing("Initial directory"));
  await reads.reply(page, "read-progress-board", 0, snapshot());
  await page.locator(".answer-form textarea").fill("Unsent draft");
  await page.clock.runFor(15000);
  assert.equal(calls.filter(call => call.name === "read-progress-board").length, 1);
  await page.locator("#board-title").click();
  await page.clock.runFor(15000);
  await reads.reply(page, "read-progress-board", 1, snapshot(2));
  await reads.reply(page, "list-progress-boards", 1, listing("New directory"));
  assert.equal(await page.locator(".answer-form textarea").inputValue(), "Unsent draft");
  assert.equal(await page.locator(".answer-preview").textContent(), "Will send: Unsent draft");
});

test("all visible header controls are clickable around the navigation breakpoint", async t => {
  for (const width of [900, 901, 910, 920, 1000, 1100, 1101, 1440]) await t.test(String(width), async t => {
    const { page } = await open(t, { width, path: "/control-room" });
    const controls = page.locator('.app-shell-header a:visible, .app-shell-header button:visible, .app-shell-menu > summary:visible');
    for (const control of await controls.all()) await control.click({ trial: true, timeout: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (width <= 900) await page.locator(".app-shell-menu > summary").click();
    else await page.locator(".app-shell-more-toggle").click();
    assert.equal(await page.locator(".app-shell-more-list").isVisible(), true);
    for (const control of await controls.all()) await control.click({ trial: true, timeout: 1000 });
  });
});
