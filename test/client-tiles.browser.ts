import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = process.env.CLIENT_TILES_SHOTS ?? "out/test-artifacts/client-tiles";
await mkdir(shots, { recursive: true });

const mix = (total: number, open_deal: number, past_client: number) => ({
  total,
  open_deal,
  past_client,
  no_deal_yet: total - open_deal - past_client,
});
// Made-up counts; Dell owns a third of each.
const tilesFor = (owner: string | null) => {
  const n = (count: number) => (owner === "dell" ? Math.floor(count / 3) : count);
  return {
    all: mix(n(120), n(12), n(30)),
    national_accounts: { accounts: 1, ...mix(n(9), n(3), 0) },
    practice_types: [
      { practice_type: "Dental", ...mix(n(64), n(6), n(18)) },
      { practice_type: "Veterinary", ...mix(n(21), n(3), n(6)) },
      { practice_type: "Physical Therapy", ...mix(n(12), 0, n(3)) },
    ],
    not_set: mix(n(23), n(3), n(3)),
  };
};

type TilesAnswer = ReturnType<typeof tilesFor> | "refused";

async function openClients(
  t: TestContext,
  width: number,
  height: number,
  theme = "dark",
  tiles: (owner: string | null) => TilesAnswer = tilesFor,
) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript((saved) => localStorage.setItem("dealroom-theme", saved), theme);
  const asked: URL[] = [];
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === "/api/v1/business/clients") asked.push(url);
    // The fixture is declared as a loose record; the tiles ride beside its list answer.
    const payload = directoryFixture(url.href) as Record<string, unknown>;
    if (url.searchParams.get("tiles") === "true") {
      const answer = tiles(url.searchParams.get("owner"));
      if (answer === "refused") return r.fulfill({ status: 503, json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } });
      payload.tiles = answer;
    }
    return r.fulfill({ json: payload });
  });
  await page.route("**/mcp", (r) => r.fulfill({ json: { jsonrpc: "2.0", id: 1, result: { content: [] } } }));
  await page.goto(`${server.url}/clients`);
  await page.locator("a.directory-tile, #directoryTiles [role=alert]").first().waitFor();
  return { page, asked };
}

const tileNames = (page: Page) => page.locator("a.directory-tile .tile-name").allTextContents();
const countOf = (page: Page, name: string) =>
  page
    .locator("a.directory-tile", { has: page.locator(".tile-name", { hasText: name }) })
    .locator(".tile-count")
    .textContent();

test("Clients opens on tiles in the approved order, and a tile opens its clients", async (t) => {
  const { page, asked } = await openClients(t, 1440, 772);
  assert.deepEqual(await tileNames(page), [
    "All clients",
    "National Accounts",
    "Dental",
    "Veterinary",
    "Physical Therapy",
    "Not set",
  ]);
  assert.equal(await page.locator(".record-row").count(), 0, "no list under the tiles");
  assert.equal(await countOf(page, "All clients"), "120");
  assert.equal(await countOf(page, "National Accounts"), "1", "one account");
  assert.equal(await page.locator("#resultSummary").textContent(), "120 clients");
  const dental = page.locator("a.directory-tile", { hasText: "Dental" });
  assert.deepEqual(await dental.locator(".tile-mix li").allTextContents(), [
    "6 Open deal",
    "18 Past client",
    "40 No deal yet",
  ]);
  assert.equal(
    await page.locator("a.directory-tile", { hasText: "National Accounts" }).locator(".tile-foot").textContent(),
    "9 locations",
  );
  assert.equal(asked.at(-1)?.searchParams.get("tiles"), "true");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollHeight > innerHeight),
    false,
    "one screen tall",
  );
  await page.screenshot({ path: `${shots}/dj-cl-a2-1440x772-dark.png` });

  await page.getByRole("button", { name: "Dell", exact: true }).click();
  await page.waitForURL(/owner=dell/);
  await page.waitForFunction(() => document.querySelector("a.directory-tile .tile-count")?.textContent === "40");
  assert.equal(asked.at(-1)?.searchParams.get("owner"), "dell");

  const listRead = (practiceType: string | null) =>
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.ok() &&
        url.pathname === "/api/v1/business/clients" &&
        !url.searchParams.has("tiles") &&
        url.searchParams.get("practice_type") === practiceType
      );
    });
  const dentalRead = listRead("Dental");
  await dental.click();
  await page.waitForURL(/practice_type=Dental/);
  const list = new URL((await dentalRead).url());
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.locator("#directoryTiles").isHidden(), true);
  assert.equal(list.searchParams.get("owner"), "dell");

  await page.goBack();
  const notSetRead = listRead("");
  await page.locator("a.directory-tile", { hasText: "Not set" }).click();
  await page.waitForURL(/not_set=true/);
  await notSetRead;
  await page.locator(".record-row").first().waitFor();

  await page.goBack();
  const allRead = listRead(null);
  await page.locator("a.directory-tile", { hasText: "All clients" }).click();
  await page.waitForURL(/all=true/);
  const all = new URL((await allRead).url());
  await page.locator(".record-row").first().waitFor();
  assert.equal(all.searchParams.has("all"), false, "All clients is the plain list read");
});

test("Inside a tile its chips count and filter its clients, and Clients goes back to the tiles", async (t) => {
  for (const [width, height] of [
    [1440, 772],
    [390, 844],
  ] as const) {
    const { page, asked } = await openClients(t, width, height, "light");
    await page.locator("a.directory-tile", { hasText: "Dental" }).click();
    await page.waitForURL(/practice_type=Dental/);
    await page.locator(".record-row").first().waitFor();
    const chips = page.locator("#tableFilters [data-status-filter]");
    await chips.first().waitFor();
    assert.deepEqual(
      await chips.allTextContents(),
      ["Open deal 6", "Past client 18", "No deal yet 40"],
      `Dental's counts at ${width}`,
    );
    assert.equal(await page.locator("#chipBar").isVisible(), false, "no removable chips beside the table");
    assert.equal(await page.locator("#searchInput").getAttribute("placeholder"), "Find in Dental");
    await page.screenshot({ path: `${shots}/dl-cl-a3-open-${width}-light.png`, fullPage: width === 390 });
    const noDeal = chips.filter({ hasText: "No deal yet" });
    await noDeal.click();
    await page.waitForURL(/status=no_deal_yet/);
    await page.locator(".record-row").first().waitFor();
    assert.equal(asked.at(-1)?.searchParams.get("status"), "no_deal_yet");
    assert.equal(await noDeal.getAttribute("aria-pressed"), "true");
    await noDeal.click();
    await page.waitForURL((url) => !url.searchParams.has("status"));
    const back = page.locator("#placeBack");
    assert.equal(await back.textContent(), "Clients");
    await back.click();
    await page.waitForURL((url) => !url.searchParams.has("practice_type"));
    await page.locator("a.directory-tile").first().waitFor();
    assert.equal(await page.locator("#listRegion").isHidden(), true);
    assert.equal(await back.isHidden(), true, "the tiles need no way back");
  }
  const { page } = await openClients(t, 1440, 772);
  await page.locator("a.directory-tile", { hasText: "All clients" }).click();
  await page.locator(".record-row").first().waitFor();
  assert.match((await page.locator("#resultSummary").textContent()) ?? "", /^All clients · /);
  await page.locator("#tableFilters [data-status-filter]").first().waitFor();
  assert.deepEqual(await page.locator("#tableFilters [data-status-filter]").allTextContents(), [
    "Open deal 12",
    "Past client 30",
    "No deal yet 78",
  ]);
});

test("A tile's link counts its chips without opening the tiles first", async (t) => {
  const { page, asked } = await openClients(t, 1280, 640);
  await page.goto(new URL("/clients?practice_type=dental&owner=dell", page.url()).href);
  await page.locator("#tableFilters [data-status-filter]").first().waitFor();
  assert.deepEqual(await page.locator("#tableFilters [data-status-filter]").allTextContents(), [
    "Open deal 2",
    "Past client 6",
    "No deal yet 13",
  ]);
  const counted = asked.filter((url) => url.searchParams.get("tiles") === "true").at(-1);
  assert.equal(counted?.searchParams.get("owner"), "dell", "the counts follow the owner chip");
  assert.equal(counted?.searchParams.has("practice_type"), false, "the counts come from the opening tiles");
});

test("No clients still shows the tiles, and a failed read shows the tile error", async (t) => {
  const zero = (): TilesAnswer => ({
    all: mix(0, 0, 0),
    national_accounts: { accounts: 0, ...mix(0, 0, 0) },
    practice_types: [],
    not_set: mix(0, 0, 0),
  });
  const empty = await openClients(t, 1440, 772, "dark", zero);
  assert.equal(await countOf(empty.page, "All clients"), "0");
  assert.equal(await empty.page.locator("#directoryTiles").isVisible(), true);

  const failed = await openClients(t, 1440, 772, "dark", () => "refused");
  assert.equal(await failed.page.locator("#directoryTiles [role=alert]").isVisible(), true);
  assert.equal(await failed.page.locator("body").getAttribute("data-tiles"), "");
});

test("A tile click opens in the app without reloading the page", async (t) => {
  const { page } = await openClients(t, 1440, 772);
  await page.evaluate(() => Reflect.set(window, "kept", true));
  await page.locator("a.directory-tile", { hasText: "Dental" }).click();
  await page.waitForURL(/practice_type=Dental/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.evaluate(() => Reflect.get(window, "kept")), true, "same page, no reload");
});

test("Find a client searches every tile and clearing it brings the tiles back", async (t) => {
  const { page, asked } = await openClients(t, 1280, 640);
  await page.screenshot({ path: `${shots}/dj-cl-a2-1280x640-dark.png` });
  const find = page.getByPlaceholder("Find a client");
  await find.fill("Demo Practice");
  await page.waitForURL(/q=Demo/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.locator("#directoryTiles").isHidden(), true);
  assert.equal(asked.at(-1)?.searchParams.has("practice_type"), false);
  await find.fill("");
  await page.waitForURL((url) => !url.searchParams.has("q"));
  await page.locator("a.directory-tile").first().waitFor();
  assert.equal(await page.locator("#listRegion").isHidden(), true);
});

test("On a phone the tiles are two across with the name and the number", async (t) => {
  const { page } = await openClients(t, 390, 844);
  const tops = await page
    .locator("a.directory-tile")
    .evaluateAll((tiles) => tiles.slice(0, 2).map((tile) => tile.getBoundingClientRect().top));
  assert.equal(tops[0], tops[1], "the first two tiles share a row");
  assert.equal(await page.locator(".tile-mix").first().isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${shots}/dj-cl-a2-390-dark.png`, fullPage: true });
});

test("Light theme", async (t) => {
  for (const [width, height] of [
    [1440, 772],
    [1280, 640],
    [390, 844],
  ] as const) {
    const { page } = await openClients(t, width, height, "light");
    await page.screenshot({
      path: `${shots}/dj-cl-a2-${width === 390 ? "390" : `${width}x${height}`}-light.png`,
      fullPage: width === 390,
    });
  }
});
