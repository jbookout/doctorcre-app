import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/directory-tiles";
await mkdir(shots, { recursive: true });

type Counts = { count: number; quiet: number; relationship: Record<string, number> };
type Summary = { all: Counts; no_category: Counts; categories: ({ slug: string; label: string } & Counts)[] };

// Three made-up vendors nobody categorized, so the No category tile shows.
function withUncategorized(url: string) {
  const payload = directoryFixture(url);
  if (!new URL(url).pathname.endsWith("/summary")) return payload;
  // The fixture is declared as a loose record; its summary answer carries the tile counts.
  const summary = payload as unknown as Summary;
  summary.no_category = { count: 3, quiet: 0, relationship: { ...summary.all.relationship, not_rated: 3 } };
  return summary;
}

async function openVendors(
  t: TestContext,
  width: number,
  height: number,
  {
    path = "/vendors",
    live = false,
    light = false,
    territoryTiles = false,
    touch = false,
    ready = ".directory-tile[href]",
  } = {},
) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height },
    colorScheme: light ? "light" : "dark",
    hasTouch: touch,
    isMobile: touch,
  });
  if (light)
    await page.addInitScript(() =>
      localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme: "light" })),
    );
  const asked: URL[] = [];
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => {
    asked.push(new URL(r.request().url()));
    return r.fulfill({ json: territoryTiles ? withMarkets(r.request().url()) : withUncategorized(r.request().url()) });
  });
  await page.route("**/mcp", (r) =>
    r.fulfill({
      json: { jsonrpc: "2.0", id: r.request().postDataJSON()?.id, result: { content: [{ type: "text", text: "{}" }] } },
    }),
  );
  if (live) {
    await page.route("**/auth/session", (r) =>
      r.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
    );
  }
  if (live || territoryTiles) {
    await page.route(
      (url) => url.pathname === "/vendors",
      async (r) => {
        const response = await r.fetch();
        return r.fulfill({
          response,
          body: (await response.text()).replace(
            "<html ",
            `<html ${live ? "data-clients-vendors-from-engine " : ""}${territoryTiles ? "data-vendor-territory-tiles " : ""}`,
          ),
        });
      },
    );
  }
  await page.goto(`${server.url}${path}${live ? `${path.includes("?") ? "&" : "?"}mode=live` : ""}`);
  await page.locator(ready).first().waitFor();
  return { page, asked };
}

const tileNames = (page: import("playwright").Page) => page.locator("a.directory-tile .tile-name").allTextContents();

test("Vendors opens on a tile per category that opens its list, and Joe recounts them", async (t) => {
  const { page, asked } = await openVendors(t, 1440, 900);
  assert.deepEqual(
    await tileNames(page),
    ["All vendors", "Architecture", "Banking", "No category"],
    "empty Attorney has no tile",
  );
  assert.equal(await page.locator(".record-row").count(), 0, "no list under the tiles");
  const all = page.locator("a.directory-tile").first();
  assert.equal(await all.locator(".tile-count").textContent(), "62");
  assert.equal(await page.locator("#resultSummary").textContent(), "62 vendors");
  assert.match((await all.locator(".tile-quiet").textContent()) ?? "", /^\d+ quiet$/);
  assert.ok(await all.locator('.tile-mix [data-relationship="core"]').isVisible());
  await page.screenshot({ path: `${shots}/tiles-1440.png` });

  await page.getByRole("button", { name: "Joe", exact: true }).click();
  await page.waitForURL(/owner=joe/);
  await page.waitForFunction(() => document.querySelector(".directory-tile .tile-count")?.textContent === "31");
  assert.equal(asked.at(-1)?.search, "?owner=joe");

  await page.locator("a.directory-tile", { hasText: "Banking" }).click();
  await page.waitForURL(/category=banker/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.locator("#directoryTiles").isHidden(), true);
  const list = asked.at(-1);
  assert.equal(list?.searchParams.get("category"), "banker");
  assert.equal(list?.searchParams.get("owner"), "joe");

  await page.getByRole("button", { name: "Categories", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/vendors" && url.search === "?owner=joe");
  await page.locator("a.directory-tile", { hasText: "No category" }).click();
  await page.waitForURL(/no_category=true/);
  await page.waitForFunction(() => document.querySelector("#directoryTiles")?.hasAttribute("hidden"));
  assert.equal(asked.at(-1)?.searchParams.get("no_category"), "true");

  await page.goBack();
  await page.locator("a.directory-tile", { hasText: "All vendors" }).click();
  await page.waitForURL(/all=true/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(asked.at(-1)?.searchParams.has("all"), false, "All vendors is the plain list read");
});

test("Find a vendor swaps the tiles for matches and clearing it brings them back", async (t) => {
  const { page } = await openVendors(t, 1280, 640);
  await page.screenshot({ path: `${shots}/tiles-1280x640.png` });
  const find = page.getByPlaceholder("Find a vendor");
  await find.fill("Partner 0");
  await page.waitForURL(/q=Partner/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.locator("#directoryTiles").isHidden(), true);
  await find.fill("");
  await page.waitForURL((url) => !url.searchParams.has("q"));
  await page.locator(".directory-tile[href]").first().waitFor();
  assert.equal(await page.locator("#listRegion").isHidden(), true);
});

test("on a phone the tiles are two across", async (t) => {
  const { page } = await openVendors(t, 390, 844);
  const boxes = await page
    .locator("a.directory-tile")
    .evaluateAll((tiles) => tiles.slice(0, 2).map((tile) => tile.getBoundingClientRect().top));
  assert.equal(boxes[0], boxes[1], "the first two tiles share a row");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const dell = await page.getByRole("button", { name: "Dell", exact: true }).boundingBox();
  assert.ok(dell && dell.x + dell.width <= 390, "the owner chips fit beside Categories");
  await page.screenshot({ path: `${shots}/tiles-390.png`, fullPage: true });
});

test("New vendor offers every category while the tiles are showing (Edit reads the same list)", async (t) => {
  const { page } = await openVendors(t, 1440, 900, { live: true });
  await page.getByRole("button", { name: "New vendor" }).click();
  const dialog = page.getByRole("dialog", { name: "New vendor" });
  const choices = await dialog.locator('input[name="categories"]').count();
  assert.ok(choices >= 3, `the form lists the categories (${choices})`);
  assert.equal(await dialog.getByText("No categories yet.").count(), 0);
});

test("a saved link to My work keeps showing the vendors recorded as yours", async (t) => {
  const { page, asked } = await openVendors(t, 1440, 900, { path: "/vendors?scope=mine", ready: ".record-row" });
  assert.equal(await page.locator("#directoryTiles").isHidden(), true);
  assert.equal(asked.at(-1)?.searchParams.get("scope"), "mine");
});

test("a refresh keeps keyboard focus on the same tile", async (t) => {
  const { page, asked } = await openVendors(t, 1440, 900);
  const tile = page.locator("a.directory-tile", { hasText: "Banking" });
  const href = await tile.getAttribute("href");
  await tile.focus();
  const reads = asked.length;
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#refreshList")?.click());
  await page.waitForFunction((n) => n > 0, reads);
  await page.waitForFunction(() => document.querySelector("#directoryTiles")?.getAttribute("aria-busy") === "false");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), href);
});

for (const width of [390, 320])
  test(`the top row keeps Joe, Dell and New vendor on screen at ${width}`, async (t) => {
    const { page } = await openVendors(t, width, 844, { live: true, light: true });
    await page.getByRole("button", { name: "New vendor" }).waitFor();
    await page.screenshot({ path: `${shots}/tiles-new-${width}.png`, fullPage: true });
    for (const name of ["New vendor", "Joe", "Dell"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${name} sits inside ${width} wide`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });

test("inside a category the relationship counts and Quiet filter the one table, and headings sort it", async (t) => {
  const { page, asked } = await openVendors(t, 1440, 900, { path: "/vendors?category=banker", ready: ".record-row" });
  const reads = () => asked.filter((url) => url.pathname.endsWith("/vendors")).length;
  const counts = page.locator("#tableFilters [data-relationship-filter]");
  const total = await page.locator(".record-row").count();
  assert.equal(total, 31, "the whole category in one table");
  assert.equal(await page.locator("#resultSummary").textContent(), "Banking · 31 vendors");
  const core = counts.filter({ hasText: "Core" });
  const shown = Number(await core.locator(".tile-n").textContent());
  const before = reads();
  await core.click();
  await page.waitForURL(/relationship=core/);
  assert.equal(await page.locator(".record-row").count(), shown, "only Core vendors");
  assert.equal(await core.getAttribute("aria-pressed"), "true");
  assert.equal(reads(), before, "the filter re-reads nothing");
  await core.click();
  await page.waitForURL((url) => !url.searchParams.has("relationship"));
  assert.equal(await page.locator(".record-row").count(), total);

  const quiet = page.getByRole("button", { name: /^Quiet/ });
  const quietRows = await page.locator(".record-row .contact-note.quiet").count();
  assert.ok(quietRows > 0, "the category holds quiet vendors");
  assert.equal(await quiet.locator(".tile-n").textContent(), String(quietRows), "Quiet counts the quiet vendors");
  await quiet.click();
  await page.waitForURL(/quiet=true/);
  await page.waitForFunction(() => document.querySelectorAll(".record-row .contact-note.quiet").length > 0);
  assert.equal(asked.at(-1)?.searchParams.get("quiet"), "true");
  assert.equal(await page.locator(".record-row .contact-note:not(.quiet)").count(), 0, "every quiet row says how long");
  await quiet.click();
  await page.waitForURL((url) => !url.searchParams.has("quiet"));

  await page.locator('[data-column-sort="name"]').click();
  await page.waitForURL(/sort=name/);
  assert.equal(asked.at(-1)?.searchParams.get("sort"), "name");
  assert.equal(await page.locator('[data-column-sort="name"]').getAttribute("aria-pressed"), "true");
  await page.locator('[data-column-sort="name"]').click();
  await page.waitForURL((url) => !url.searchParams.has("sort"));
  assert.equal(await page.locator(".list-head [data-fact=Category]").count(), 0, "no Category column inside one");
});

test("outside a category the relationship counts and the Quiet count stay away, however small the answer", async (t) => {
  const { page } = await openVendors(t, 1440, 900, { path: "/vendors?all=true&q=Partner+0", ready: ".record-row" });
  assert.equal(await page.locator("#tableFilters [data-relationship-filter]").count(), 0);
  assert.equal(await page.getByRole("button", { name: /^Quiet/ }).textContent(), "Quiet");
});

test("a filter that matches nothing says so and Clear filters brings the category back", async (t) => {
  const { page } = await openVendors(t, 1280, 640, {
    path: "/vendors?category=banker&q=Nobody",
    ready: ".record-empty",
  });
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.waitForURL((url) => url.search === "?category=banker");
  await page.locator(".record-row").first().waitFor();
});

for (const width of [320, 390])
  test(`at ${width} wide a tile's count stays inside its tile`, async (t) => {
    const { page } = await openVendors(t, width, 740);
    const touching = await page.locator("a.directory-tile").evaluateAll((tiles) =>
      tiles
        .filter((tile) => {
          const count = tile.querySelector(".tile-count")?.getBoundingClientRect();
          return count && count.right > tile.getBoundingClientRect().right - 8;
        })
        .map((tile) => tile.querySelector(".tile-name")?.textContent),
    );
    assert.deepEqual(touching, []);
  });

const MARKETS = [
  "Mobile",
  "Eastern Shore",
  "Orange Beach / Gulf Shores",
  "Dothan",
  "Pensacola",
  "Pace",
  "Milton",
  "Gulf Breeze",
  "Navarre",
  "Crestview",
  "Niceville",
  "Fort Walton Beach",
  "Destin",
  "Miramar Beach",
  "30A / Santa Rosa Beach",
  "Freeport",
  "Panama City Beach",
  "Panama City",
  "Tallahassee",
].map((name, index) => ({ id: `00000000-0000-4000-8000-${String(800 + index).padStart(12, "0")}`, name }));

function withMarkets(url: string) {
  const requested = new URL(url);
  const payload = directoryFixture(url);
  if (requested.pathname.endsWith("/summary")) {
    // The synthetic adapter returns the summary envelope for this route.
    const summary = payload as unknown as Summary;
    const coverage = (count: number, bucketSize: number) => ({
      markets: MARKETS.slice()
        .reverse()
        .map((market) => ({ ...market, count: market.name === "Mobile" ? bucketSize : count - 2 * bucketSize }))
        .filter((market) => market.count),
      elsewhere: bucketSize,
      no_territory: bucketSize,
    });
    Object.assign(summary.all, coverage(summary.all.count, requested.searchParams.has("owner") ? 1 : 2));
    for (const counts of [summary.no_category, ...summary.categories])
      Object.assign(counts, coverage(counts.count, Number(counts.count > 0)));
  } else if (requested.searchParams.get("markets") === "true" && Array.isArray(payload.rows)) {
    assert.ok(payload.query && typeof payload.query === "object");
    Object.assign(payload.query, { markets: true });
    for (const row of payload.rows) {
      const n = Number(row.id.slice(-12));
      row.markets = n <= 4 && n >= 3 ? [] : n <= 2 ? MARKETS : MARKETS.slice(1);
      if (n === 3 || n === 4) row.territory = null;
      if (n === 5 || n === 6) row.markets = [];
    }
  }
  return payload;
}

test("territory tiles combine with search and clear in place", async (t) => {
  const { page, asked } = await openVendors(t, 1440, 900, {
    path: "/vendors?category=banker",
    territoryTiles: true,
    ready: ".record-row",
  });
  const group = page.getByRole("group", { name: "Territories" });
  const mobile = group.getByRole("button", { name: "Mobile 1" });
  await mobile.waitFor();
  assert.deepEqual(await group.locator("button span:first-child").allTextContents(), [
    "All territories",
    ...MARKETS.map(({ name }) => name),
    "Elsewhere",
    "No territory",
  ]);
  assert.equal(await page.locator(".record-row").count(), 31);
  const reads = asked.length;
  await mobile.click();
  assert.equal(await mobile.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".record-row").count(), 1);
  assert.equal(asked.length, reads, "choosing a territory does not read the list again");
  await mobile.click();
  assert.equal(await page.locator(".record-row").count(), 31);
  await group.getByRole("button", { name: "Elsewhere 1" }).click();
  assert.match((await page.locator(".record-row").textContent()) ?? "", /Demo Partner 05/);
  await group.getByRole("button", { name: "No territory 1" }).click();
  assert.match((await page.locator(".record-row").textContent()) ?? "", /Demo Partner 03/);
  await page.getByPlaceholder("Find in Banking").fill("missing");
  await page.getByText("No vendors match these filters").waitFor();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.locator(".record-row").first().waitFor();
  assert.equal(await group.getByRole("button", { name: "All territories 31" }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByPlaceholder("Find in Banking").inputValue(), "");
  await page.screenshot({ path: `${shots}/territories-1440.png` });
  await page.getByRole("button", { name: "Categories", exact: true }).click();
  await page.locator("a.directory-tile", { hasText: "All vendors" }).click();
  await group.getByRole("button", { name: "All territories 62" }).waitFor();
  await page.getByRole("button", { name: "Dell", exact: true }).click();
  await group.getByRole("button", { name: "All territories 31" }).waitFor();
  await group.getByRole("button", { name: "Mobile 1" }).click();
  assert.match((await page.locator(".record-row").textContent()) ?? "", /Demo Partner 02/);
  await page.getByRole("button", { name: "People worth meeting" }).click();
  assert.equal(await group.isVisible(), false);
  assert.equal(await page.locator(".app-layout-main").evaluate((main) => getComputedStyle(main).overflowY), "auto");
});

for (const [width, height, touch] of [
  [1280, 640, false],
  [390, 844, true],
] as const) {
  test(`territory tiles fit at ${width}×${height}`, async (t) => {
    const { page } = await openVendors(t, width, height, {
      path: "/vendors?category=banker",
      territoryTiles: true,
      touch,
      light: touch,
      ready: ".record-row",
    });
    const group = page.getByRole("group", { name: "Territories" });
    await page.evaluate(() => (document.documentElement.dataset.colorAssist = "on"));
    await group.waitFor();
    if (touch) {
      assert.ok(await group.evaluate((row) => row.scrollWidth > row.clientWidth));
      const firstTile = await group.getByRole("button").first().boundingBox();
      assert.ok(firstTile && firstTile.height >= 44);
      await group.getByRole("button", { name: "No territory 1" }).tap();
      assert.equal(await page.locator(".record-row").count(), 1);
      await group.getByRole("button", { name: "All territories 31" }).tap();
    } else {
      const wholeRows = await page.locator("#listRegion").evaluate((region) => {
        const edge = region.getBoundingClientRect();
        return [...region.querySelectorAll(".record-row")].filter((row) => {
          const box = row.getBoundingClientRect();
          return box.top >= edge.top && box.bottom <= Math.min(edge.bottom, innerHeight);
        }).length;
      });
      assert.ok(wholeRows >= 11, `${wholeRows} whole vendor rows`);
      const region = page.locator("#listRegion");
      const top = await group.boundingBox();
      await region.evaluate((list) => {
        list.scrollTop = 200;
      });
      assert.ok(await region.evaluate((list) => list.scrollTop > 0));
      assert.deepEqual(await group.boundingBox(), top);
    }
    await page.screenshot({ path: `${shots}/territories-${width}.png` });
  });
}

test("territory tiles and market reads stay off before rollout", async (t) => {
  const { page, asked } = await openVendors(t, 1440, 900, {
    path: "/vendors?category=banker&market=elsewhere",
    ready: ".record-row",
  });
  assert.equal(await page.getByRole("group", { name: "Territories" }).isVisible(), false);
  assert.equal(
    asked.some((url) => url.searchParams.has("markets")),
    false,
  );
  assert.equal(new URL(page.url()).searchParams.has("market"), false);
});

test("Tab through the vendor table scrolls only the list", async (t) => {
  const { page } = await openVendors(t, 1280, 640, {
    path: "/vendors?category=banker",
    territoryTiles: true,
    ready: ".record-row",
  });
  const tiles = page.getByRole("group", { name: "Territories" });
  await tiles.waitFor();
  const headings = page.locator(".list-head");
  const tilesTop = (await tiles.boundingBox())?.y;
  const headingsTop = (await headings.boundingBox())?.y;
  const rows = page.locator(".record-row");
  assert.equal(await rows.count(), 31);
  await rows.first().focus();
  for (let index = 1; index < 31; index++) {
    await page.keyboard.press("Tab");
    assert.equal(await rows.nth(index).evaluate((row) => row === document.activeElement), true);
  }
  assert.equal(
    await page.locator(".app-layout-main").evaluate((main) => main.scrollTop),
    0,
    "the outer workspace scrolled",
  );
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  assert.ok(await page.locator("#listRegion").evaluate((list) => list.scrollTop > 0));
  assert.equal((await tiles.boundingBox())?.y, tilesTop);
  assert.equal((await headings.boundingBox())?.y, headingsTop);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await rows.nth(29).evaluate((row) => row === document.activeElement), true);
});

test("a phone vendor card removes the territory and table controls from keyboard navigation", async (t) => {
  const { page } = await openVendors(t, 390, 844, {
    path: "/vendors?category=banker",
    territoryTiles: true,
    touch: true,
    ready: ".record-row",
  });
  await page.getByRole("group", { name: "Territories" }).waitFor();
  const quiet = page.locator("#tableFilters [data-quiet-filter]");
  const first = page.locator(".record-row").first();
  await first.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Demo Partner 01" }).waitFor();

  // A focus request must be refused by the covered background itself.
  await quiet.focus();
  assert.equal(
    await quiet.evaluate((button) => button === document.activeElement),
    false,
    "Quiet accepted focus behind the card",
  );
  assert.equal(await page.getByRole("group", { name: "Show only" }).count(), 0);
  for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    assert.ok(await dialog.evaluate((panel) => panel.contains(document.activeElement)));
  }
  await page.keyboard.press("Escape");
  assert.ok(await first.evaluate((row) => row === document.activeElement), "focus returns to the row");
  await quiet.focus();
  assert.ok(await quiet.evaluate((button) => button === document.activeElement), "Quiet accepts focus after closing");
});
