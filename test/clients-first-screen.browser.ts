import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/clients-first-screen";
await mkdir(shots, { recursive: true });

async function openClients(
  t: TestContext,
  width: number,
  height: number,
  {
    path = "/clients?all=true",
    ready = ".record-row",
    held,
  }: { path?: string; ready?: string; held?: Promise<void> } = {},
) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
  await page.clock.install({ time: new Date("2026-10-01T18:00:00Z") });
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", async (r) => {
    await held;
    const url = new URL(r.request().url());
    return r.fulfill({ json: directoryFixture(url.href) });
  });
  await page.route("**/mcp", (route) => {
    const request = route.request().postDataJSON();
    return route.fulfill({
      json: { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "{}" }] } },
    });
  });
  await page.goto(`${server.url}${path}`);
  await page.locator(ready).first().waitFor();
  return { page };
}

const firstScreen = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect() ?? new DOMRect();
    const rows = [...document.querySelectorAll(".record-row")].map((row) => row.getBoundingClientRect());
    return {
      pageScrolls: document.documentElement.scrollHeight > innerHeight,
      sideways: document.documentElement.scrollWidth > innerWidth,
      listTop: Math.round(box("#recordList").top),
      listWidth: Math.round(box("#recordList").width),
      mainWidth: Math.round(box("#main").width),
      wholeRows: rows.filter((row) => row.top >= 0 && row.bottom <= innerHeight).length,
    };
  });

for (const [width, height] of [
  [1280, 800],
  [1440, 900],
] as const)
  test(`the Clients list fills the first screen at ${width}x${height}`, async (t) => {
    const { page } = await openClients(t, width, height);
    await page.screenshot({ path: `${shots}/clients-${width}.png` });
    const fit = await firstScreen(page);
    assert.equal(fit.pageScrolls, false, "the page itself does not scroll");
    assert.equal(fit.sideways, false, "nothing scrolls sideways");
    // Search and the status chips share the toolbar's one row.
    assert.ok(fit.listTop <= 112, `the list starts near the top, not at ${fit.listTop}px`);
    assert.ok(fit.listWidth >= fit.mainWidth - 48, `the list is ${fit.listWidth}px of a ${fit.mainWidth}px page`);
    assert.ok(fit.wholeRows >= 8, `at least eight clients show whole, not ${fit.wholeRows}`);
    const before = {
      search: await page.locator("#searchInput").boundingBox(),
      row: await page.locator(".record-row").first().boundingBox(),
    };
    await page.mouse.move(width / 2, height - 100);
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(
      (top) => (document.querySelector(".record-row")?.getBoundingClientRect().top ?? top) < top - 100,
      before.row?.y ?? 0,
    );
    assert.equal(await page.evaluate(() => scrollY), 0, "the list scrolls, not the page");
    assert.deepEqual(await page.locator("#searchInput").boundingBox(), before.search, "the toolbar stays in place");
  });

test("Clients rows take one line each under one header row that names the columns", async (t) => {
  const { page } = await openClients(t, 1280, 640);
  await page.screenshot({ path: `${shots}/clients-1280x640.png` });
  assert.ok((await firstScreen(page)).wholeRows >= 11, "at least 11 clients show whole at 1280x640");
  const columns = await page.evaluate(() => {
    const left = (node: Element | null | undefined) => Math.round(node?.getBoundingClientRect().left ?? Number.NaN);
    const item = document.querySelector(".record-item");
    const row = item?.querySelector(".record-row");
    return [...document.querySelectorAll(".list-head :is([data-fact], .row-owner, .row-updated)")].map((label) => {
      const fact = label.getAttribute("data-fact");
      // The open deal is its own link, laid in its column over the row.
      const value =
        fact === "Open deal"
          ? item?.querySelector(".client-deals a")
          : fact
            ? row?.querySelector(`[data-fact="${fact}"] .fact-value`)
            : row?.querySelector(`.${label.className}`);
      return { label: label.textContent, header: left(label), value: left(value) };
    });
  });
  assert.deepEqual(
    columns.map(({ label }) => label),
    ["Status", "Practice type", "Open deal", "Client type", "Territory", "Owner", "Updated"],
  );
  for (const { label, header, value } of columns) assert.equal(value, header, `${label} values sit under their label`);
  const inline = await page.evaluate(
    () =>
      [...document.querySelectorAll(".record-row .fact-label")].filter((l) => l.getBoundingClientRect().width > 1)
        .length,
  );
  assert.equal(inline, 0, "rows drop the labels the header already shows");
  await page.mouse.move(640, 500);
  await page.mouse.wheel(0, 600);
  await page.waitForFunction(
    () =>
      (document.querySelector(".record-row")?.getBoundingClientRect().top ?? 0) < 0 &&
      !document.querySelector("#noticeRegion")?.textContent,
  );
  const gap = await page.evaluate(() => {
    const bottom = document.querySelector(".search-dock")?.getBoundingClientRect().bottom ?? Number.NaN;
    return Math.abs((document.querySelector(".list-head")?.getBoundingClientRect().top ?? Number.NaN) - bottom);
  });
  assert.ok(gap <= 1, `the header row stays under the toolbar, ${gap}px away`);
});

test("the Clients toolbar and list share one left edge and draw no box", async (t) => {
  const { page } = await openClients(t, 1280, 800);
  const edges = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector) ?? document.body;
    const left = (selector: string) => Math.round(box(selector).getBoundingClientRect().left);
    const border = (selector: string) => getComputedStyle(box(selector)).borderTopWidth;
    return {
      search: left("#searchInput"),
      head: left(".list-head"),
      row: left(".record-row"),
      dock: border(".search-dock"),
      list: border("#recordList"),
    };
  });
  assert.deepEqual(edges, { search: edges.row, head: edges.row, row: edges.row, dock: "0px", list: "0px" });
});

test("a Clients search with no match says so in one line with one action", async (t) => {
  const { page } = await openClients(t, 1280, 800, { path: "/clients?q=Nobody", ready: ".record-empty" });
  const lines = await page.locator(".record-empty > *").allTextContents();
  assert.deepEqual(lines, ["No clients match these filters", "Clear all filters"]);
});

test("loading Clients shows row-height placeholders that fill the list", async (t) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { page } = await openClients(t, 1280, 800, { ready: ".record-skeleton", held });
  const heights = await page.locator(".record-skeleton").evaluateAll((rows) => rows.map((row) => row.clientHeight));
  release();
  assert.ok(heights.length >= 8, `${heights.length} placeholders`);
  assert.ok(Math.max(...heights) <= 40, `placeholders are one row tall, not ${Math.max(...heights)}px`);
});

test("a column name sorts the list and a second click returns to name order", async (t) => {
  const { page } = await openClients(t, 1280, 800);
  for (const [label, sort] of [
    ["Status", "status"],
    ["Practice type", "vertical"],
    ["Territory", "territory"],
    ["Owner", "owner"],
    ["Updated", "recent"],
  ] as const) {
    const heading = page.locator(".list-head").getByRole("button", { name: label, exact: true });
    const [response] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/v1/business/clients" && url.searchParams.get("sort") === sort;
      }),
      heading.click(),
    ]);
    assert.equal(response.ok(), true, `${label} asks the engine for its order`);
    await page.waitForURL(new RegExp(`sort=${sort}`));
    assert.equal(await heading.getAttribute("aria-pressed"), "true");
  }
  await page.locator(".list-head").getByRole("button", { name: "Updated", exact: true }).click();
  await page.waitForURL((url) => !url.searchParams.has("sort"));
  for (const label of ["Open deal", "Client type"])
    assert.equal(
      await page.locator(".list-head").getByRole("button", { name: label }).count(),
      0,
      `${label} does not sort`,
    );
});

test("inside a practice type the table drops the Practice type column", async (t) => {
  const { page } = await openClients(t, 1280, 800, { path: "/clients?practice_type=Dental" });
  const labels = await page.locator(".list-head [data-fact]").allTextContents();
  assert.deepEqual(labels, ["Status", "Open deal", "Client type", "Territory"]);
});

test("search and the status chips share one toolbar row under the owner chips", async (t) => {
  const { page } = await openClients(t, 1280, 800);
  await page.locator("#tableFilters [data-status-filter]").first().waitFor();
  const controls = [
    page.getByRole("searchbox", { name: "Search" }),
    ...(await page.locator("#tableFilters [data-status-filter]").all()),
  ];
  const middles = await Promise.all(
    controls.map(async (control) => {
      const box = await control.boundingBox();
      return box ? box.y + box.height / 2 : Number.NaN;
    }),
  );
  assert.ok(Math.max(...middles) - Math.min(...middles) < 8, `the controls sit on one row: ${middles.join(", ")}`);
  assert.equal(await page.locator("#filterForm select:visible").count(), 0, "the chips replace the dropdowns");
  const joe = await page
    .getByRole("group", { name: "Record scope" })
    .getByRole("button", { name: "Joe" })
    .boundingBox();
  assert.ok(joe && joe.y + joe.height <= Math.min(...middles), "the owner chips sit above, beside the page title");
});

test("Clients stays usable on a phone", async (t) => {
  const { page } = await openClients(t, 390, 844);
  await page.screenshot({ path: `${shots}/clients-390.png` });
  assert.equal((await firstScreen(page)).sideways, false, "nothing scrolls sideways");
  assert.equal(await page.getByRole("button", { name: "Apply" }).count(), 0, "there is no Apply button");
  const row = await page.locator(".record-row").first().boundingBox();
  assert.ok(row && row.y <= 260, `the first client starts at ${row?.y}px`);
  await page.locator("#tableFilters [data-status-filter]", { hasText: "Open deal" }).click();
  await page.waitForURL(/status=active_deal/);
  await page.locator(".record-row").first().waitFor();
  assert.equal((await firstScreen(page)).sideways, false, "the chips fit the width");
  await page.screenshot({ path: `${shots}/clients-390-filters.png` });
  await page.locator(".record-row").first().click();
  await page.getByRole("dialog").getByRole("heading", { name: "Demo Practice 01" }).waitFor();
});
