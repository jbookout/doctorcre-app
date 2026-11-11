import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/vendor-markets.v1.json", import.meta.url), "utf8"));
async function setup(t: import("node:test").TestContext, width = 1440, theme = "light", alias = false) {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: {
      APP_ENV: "production",
      GIT_SHA: "1".repeat(40),
      CARR: {
        fetch: async () =>
          Response.json({ actor: { slug: "joe", display_name: "Joe" }, csrf_token: "synthetic-session" }),
      },
    },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  let mode = "ready";
  const selectors: unknown[] = [];
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => {
    const url = new URL(r.request().url());
    const vendor = fixture.vendors.find((v: { id: string }) => url.pathname.endsWith(`/${v.id}`));
    if (!vendor) return r.fulfill({ json: directoryFixture(url.href) });
    const template = directoryFixture(url.href.replace(vendor.id, "00000000-0000-4000-8000-000000000001"));
    assert.ok("record" in template && template.record && typeof template.record === "object");
    return r.fulfill({
      json: { ...template, record: { ...template.record, id: vendor.id, name: vendor.name, ref: vendor.ref } },
    });
  });
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
  await page.goto(`${server.origin}/vendors${alias ? "?vendorView=market&vendorMarket=sand%20destin" : ""}`);
  const section = page.getByRole("region", { name: "Vendor directory view" });
  await section.getByRole("button", { name: "Market", exact: true }).waitFor({ timeout: 10000 });
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

test("reviewer signed-in Vendors probe settles then reloads at exactly /vendors", async (t) => {
  const assets = await appAssetSnapshot();
  const server = await startWorkerFixture({
    assets,
    env: {
      APP_ENV: "production",
      GIT_SHA: "1".repeat(40),
      CARR: {
        fetch: async (request: Request) => {
          const url = new URL(request.url);
          if (url.pathname.startsWith("/api/v1/business/")) return Response.json(directoryFixture(request.url));
          if (url.pathname === "/mcp") {
            const req = await request.json();
            return Response.json({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "{}" }] } });
          }
          return Response.json({ actor: { slug: "joe", display_name: "Joe" }, csrf_token: "synthetic-session" });
        },
      },
    },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route(/.*/, (r) => (new URL(r.request().url()).origin === server.origin ? r.continue() : r.abort()));
  await page.goto(`${server.origin}/vendors`);
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForTimeout(1000);
  assert.equal(page.url(), `${server.origin}/vendors`);
});

for (const width of [390, 1440])
  for (const theme of ["light", "dark"])
    test(`all-market comparison preserves distinct identity and declared coverage ${width} ${theme}`, async (t) => {
      const { page, section, selectors } = await setup(t, width, theme);
      await section.getByRole("button", { name: "Market", exact: true }).click();
      const comparison = section.getByRole("region", { name: "All-market comparison" });
      await comparison.waitFor({ timeout: 3000 });
      assert.equal(await comparison.locator("[data-comparison-market]").count(), 3);
      for (const market of fixture.markets) {
        const card = comparison.locator(`[data-comparison-market="${market.slug}"]`);
        assert.equal(await card.locator("[data-comparison-count]").textContent(), String(market.vendor_count));
        assert.equal(
          await card.locator("[data-comparison-offices]").textContent(),
          String(market.memberships.filter((m: { office_presence: boolean }) => m.office_presence).length),
        );
        for (const member of market.memberships) {
          const row = card.locator(`[data-comparison-vendor="${member.vendor_id}"]`);
          assert.equal(
            await row.locator("[data-service-coverage]").textContent(),
            `Service coverage: ${member.service_coverage || "Not recorded"}`,
          );
          const vendor = fixture.vendors.find((v: { id: string }) => v.id === member.vendor_id);
          assert.equal(await row.locator("[data-vendor-ref]").textContent(), vendor.ref);
        }
      }
      assert.equal(
        await comparison
          .getByRole("region", { name: "Local markets" })
          .locator('[data-comparison-vendor="30122e2b-18d5-474a-85b9-174ab7cad96d"]')
          .count(),
        0,
      );
      const links = comparison.getByRole("link", { name: "Synthetic multi", exact: true });
      assert.equal(await links.count(), 2);
      assert.equal(await links.nth(0).getAttribute("href"), await links.nth(1).getAttribute("href"));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      for (const control of await comparison.locator("button, a").all()) {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width, "Comparison controls fit the viewport");
      }
      await page.evaluate(() => scrollTo(0, 0));
      await mkdir("/tmp/WR591.S25.J13-shots", { recursive: true });
      await page.screenshot({ path: `/tmp/WR591.S25.J13-shots/comparison-${width}-${theme}.png`, fullPage: true });
      await comparison.getByRole("button", { name: "Open sandestin", exact: true }).click();
      await section.locator('[data-market-slug="sandestin"]').waitFor();
      await section.getByRole("button", { name: "Refresh markets", exact: true }).click();
      await section.locator('[data-market-slug="sandestin"]').waitFor();
      assert.equal(selectors.at(-1), "sandestin");
      await section.getByRole("button", { name: "Compare all markets", exact: true }).click();
      await comparison.waitFor();
      await page.reload();
      await comparison.waitFor();
      assert.equal(new URL(page.url()).searchParams.has("vendorMarket"), false);
    });

test("comparison and selected market return from the existing vendor detail", async (t) => {
  const { page, section } = await setup(t, 390);
  await section.getByRole("button", { name: "Market", exact: true }).click();
  const comparison = section.getByRole("region", { name: "All-market comparison" });
  await comparison.getByRole("link", { name: "Synthetic multi", exact: true }).first().click();
  await page
    .locator("#recordPanel")
    .getByRole("heading", { name: "Synthetic multi", exact: true })
    .waitFor({ timeout: 10000 });
  await page.locator("#recordClose").click();
  await comparison.waitFor();
  assert.equal(new URL(page.url()).searchParams.get("record"), null);
  await comparison.getByRole("button", { name: "Open sandestin", exact: true }).click();
  const local = section.locator('[data-market-slug="sandestin"]');
  await local.getByRole("link", { name: "Synthetic multi", exact: true }).click();
  await page
    .locator("#recordPanel")
    .getByRole("heading", { name: "Synthetic multi", exact: true })
    .waitFor({ timeout: 10000 });
  await page.keyboard.press("Escape");
  await local.waitFor();
  assert.equal(new URL(page.url()).searchParams.get("vendorMarket"), "sandestin");
  await section
    .getByRole("region", { name: "Regional coverage references" })
    .getByRole("link", { name: "Synthetic regional", exact: true })
    .click();
  await page
    .locator("#recordPanel")
    .getByRole("heading", { name: "Synthetic regional", exact: true })
    .waitFor({ timeout: 10000 });
  await page.locator("#recordClose").click();
  await local.waitFor();
});

test("comparison unavailable and empty states recover without stale counts", async (t) => {
  const { section, setMode } = await setup(t, 390);
  await section.getByRole("button", { name: "Market", exact: true }).click();
  const comparison = section.getByRole("region", { name: "All-market comparison" });
  await comparison.waitFor();
  setMode("fail");
  await section.getByRole("button", { name: "Refresh markets" }).click();
  await section.getByRole("alert").waitFor();
  assert.equal(await comparison.count(), 0);
  setMode("empty");
  await section.getByRole("button", { name: "Refresh markets" }).click();
  await section.getByRole("status").filter({ hasText: "No reviewed markets yet" }).waitFor();
  assert.equal(await comparison.count(), 0);
  setMode("ready");
  await section.getByRole("button", { name: "Refresh markets" }).click();
  await comparison.waitFor();
});
