import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { startFixtureServer } from "../scripts/fixture-server.mjs";
import { chromium } from "./browser-harness.mjs";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/vendor-markets.v1.json", import.meta.url), "utf8"));
async function setup(t: import("node:test").TestContext, width = 1440, theme = "light", alias = false) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  let mode = "ready";
  const selectors: unknown[] = [];
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: directoryFixture(r.request().url()) }));
  await page.route("**/mcp", async (r) => {
    const req = r.request().postDataJSON();
    let payload = {};
    if (req.params.name === "read-vendor-markets-v1") {
      selectors.push(req.params.arguments.market);
      payload =
        mode === "empty"
          ? {
              ok: true,
              schema_version: "vendor-markets.v1",
              state: "empty",
              selected_market: null,
              markets: [],
              vendors: [],
            }
          : {
              ...fixture,
              selected_market:
                req.params.arguments.market === "sand destin" ? "sandestin" : (req.params.arguments.market ?? null),
            };
      if (mode === "fail") {
        await r.abort();
        return;
      }
    }
    await r.fulfill({
      json: { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } },
    });
  });
  await page.addInitScript(
    (theme) => localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme })),
    theme,
  );
  await page.goto(`${server.url}/vendors${alias ? "?vendorView=market&vendorMarket=sand%20destin" : ""}`);
  const section = page.getByRole("region", { name: "Vendor directory view" });
  await section.getByRole("button", { name: "Market", exact: true }).waitFor();
  return {
    page,
    section,
    selectors,
    setMode: (m: string) => {
      mode = m;
    },
  };
}
for (const width of [390, 1440])
  for (const theme of ["light", "dark"])
    test(`market membership, multi-market, Regional, refresh and empty ${width} ${theme}`, async (t) => {
      const { page, section, selectors, setMode } = await setup(t, width, theme);
      await section.getByRole("button", { name: "Market", exact: true }).click();
      const select = section.getByLabel("Reviewed market", { exact: true });
      await select.waitFor();
      await select.selectOption("sandestin");
      await section.locator('[data-market-slug="sandestin"]').waitFor();
      const local = section.locator('[data-market-slug="sandestin"]');
      assert.equal(await local.locator("[data-market-vendor]").count(), 1);
      assert.equal(await local.locator("[data-market-count]").textContent(), "1 vendors");
      assert.equal(await local.locator("[data-other-markets]").textContent(), "Other market references: other");
      assert.equal(
        await local.locator("[data-service-coverage]").textContent(),
        "Service coverage: Explicit local service",
      );
      assert.equal(
        await local.locator("[data-office-evidence]").textContent(),
        "Office location: Verified street address not recorded",
      );
      assert.equal(
        await section
          .getByRole("region", { name: "Regional coverage references" })
          .locator("[data-market-vendor]")
          .count(),
        1,
      );
      const evidence = local.locator(".market-evidence");
      assert.equal(await evidence.getAttribute("open"), null);
      await evidence.locator("summary").click();
      assert.deepEqual(
        await local.locator("[data-market-person] strong").allTextContents(),
        fixture.vendors
          .find((v: { id: string }) => v.id === "7cc31999-d3c9-4f8f-865a-1aa2a0ffe066")
          .people.map((p: { contact: { name: string } }) => p.contact.name),
      );
      assert.equal(await local.locator("[data-office-evidence]").isVisible(), true);
      await evidence.locator("summary").click();
      await mkdir("/tmp/WR591.S25.J6-shots", { recursive: true });
      await page.screenshot({ path: `/tmp/WR591.S25.J6-shots/populated-${width}-${theme}.png` });
      await page.reload();
      await section.locator('[data-market-slug="sandestin"]').waitFor();
      assert.equal(selectors.at(-1), "sandestin");
      await section.getByRole("button", { name: "Refresh markets" }).click();
      await local.waitFor();
      assert.equal(selectors.at(-1), "sandestin");
      await select.selectOption("panhandle");
      await section.locator('[data-market-slug="panhandle"]').waitFor();
      assert.equal(await section.getByRole("region", { name: "Regional coverage references" }).count(), 0);
      await page.screenshot({ path: `/tmp/WR591.S25.J6-shots/regional-${width}-${theme}.png` });
      setMode("empty");
      await section.getByRole("button", { name: "Refresh markets" }).click();
      await section.getByText(/^No reviewed markets yet/).waitFor();
      await page.screenshot({ path: `/tmp/WR591.S25.J6-shots/empty-${width}-${theme}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await section.getByRole("button", { name: "Category", exact: true }).click();
      assert.equal(await page.locator("#recordList").isVisible(), true);
    });
test("producer resolves aliases; unavailable retries; session retirement erases answers", async (t) => {
  const { page, section, setMode, selectors } = await setup(t, 1440, "light", true);
  await section.locator('[data-market-slug="sandestin"]').waitFor();
  assert.ok(selectors.includes("sand destin"));
  assert.equal(new URL(page.url()).searchParams.get("vendorMarket"), "sandestin");
  setMode("fail");
  await section.getByRole("button", { name: "Refresh markets" }).click();
  await section.getByRole("alert").waitFor();
  setMode("ready");
  await section.getByRole("button", { name: "Refresh markets" }).click();
  await section.locator('[data-market-slug="sandestin"]').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
  assert.equal(await section.count(), 0);
});

test("category switch and session retirement fence late success and failure", async (t) => {
  const { page } = await setup(t);
  await page.evaluate(async (fixture) => {
    const path = "/js/ui-vendor-markets.js";
    const { mountVendorMarkets } = await import(path);
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const pending: { resolve: (value: unknown) => void; reject: (value: Error) => void }[] = [];
    const mounted = mountVendorMarkets(host, {
      category: [],
      href: () => "/vendors",
      load: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
    const click = (name: string) => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent === name);
      if (!button) throw Error(`Missing ${name}`);
      button.click();
    };
    click("Market");
    await tick();
    click("Category");
    await tick();
    pending[0]?.resolve(fixture);
    await tick();
    if (host.querySelector("[data-market-vendor]")) throw Error("Late success repainted Category");
    click("Market");
    await tick();
    click("Category");
    await tick();
    pending[1]?.reject(Error("Late failure"));
    await tick();
    if (host.querySelector('[role="alert"]')) throw Error("Late failure repainted Category");
    click("Market");
    await tick();
    window.dispatchEvent(new Event("doctorcre-session-invalidated"));
    pending[2]?.resolve(fixture);
    await tick();
    if (host.textContent) throw Error("Retired session repainted");
    mounted.dispose();
  }, fixture);
});

for (const theme of ["light", "dark"])
  test(`one local vendor keeps Regional references in the first phone viewport ${theme}`, async (t) => {
    const { page, section } = await setup(t, 390, theme, true);
    await page.setViewportSize({ width: 390, height: 844 });
    await section.locator('[data-market-slug="sandestin"]').waitFor();
    const regional = section.getByRole("heading", { name: "Regional coverage references", exact: true });
    const box = await regional.boundingBox();
    assert.ok(
      box && box.y >= 0 && box.y + box.height <= 844,
      "Regional references must start in the first phone viewport",
    );
  });

async function settle(page: import("playwright").Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)));
      }),
  );
}

test("Category settles and reloads at exactly /vendors", async (t) => {
  const { page, section } = await setup(t);
  const expected = `${new URL(page.url()).origin}/vendors`;
  await settle(page);
  const settledUrl = page.url();
  await page.reload();
  await section.getByRole("button", { name: "Category", exact: true }).waitFor();
  await settle(page);
  assert.equal(page.url(), expected);
  assert.equal(settledUrl, expected);
});

test("Market selection then Category replaces URL state and reloads at exactly /vendors", async (t) => {
  const { page, section } = await setup(t);
  const expected = `${new URL(page.url()).origin}/vendors`;
  const historyLength = await page.evaluate(() => history.length);
  await section.getByRole("button", { name: "Market", exact: true }).click();
  const select = section.getByLabel("Reviewed market", { exact: true });
  await select.waitFor();
  await select.selectOption("sandestin");
  await section.locator('[data-market-slug="sandestin"]').waitFor();
  await settle(page);
  assert.equal(page.url(), `${expected}?vendorView=market&vendorMarket=sandestin`);
  await section.getByRole("button", { name: "Category", exact: true }).click();
  await settle(page);
  assert.equal(page.url(), expected);
  assert.equal(await page.evaluate(() => history.length), historyLength);
  await page.reload();
  await section.getByRole("button", { name: "Category", exact: true }).waitFor();
  await settle(page);
  assert.equal(page.url(), expected);
  assert.equal(
    await section.getByRole("button", { name: "Category", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
});

test("canonical Market deep link restores Market and its selection", async (t) => {
  const { page, section } = await setup(t);
  const expected = `${new URL(page.url()).origin}/vendors?vendorView=market&vendorMarket=sandestin`;
  await page.goto(expected);
  await section.locator('[data-market-slug="sandestin"]').waitFor();
  await settle(page);
  assert.equal(await section.getByRole("button", { name: "Market", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await section.getByLabel("Reviewed market", { exact: true }).inputValue(), "sandestin");
  assert.equal(page.url(), expected);
});
