import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { navigationItems } from "../js/routes.js";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

for (const width of [1440, 390]) {
  test(`Deals leads DOM, visual and keyboard navigation at ${width}`, async (t) => {
    const server = await startWorkerFixture({
      assets: await appAssetSnapshot(),
      env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
    });
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    await mkdir("/tmp/WR591.S1.J1-shots", { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      try {
        await page.addInitScript((theme) => localStorage.setItem("dealroom-theme", theme), theme);
        await page.route("**/auth/session", (route) =>
          route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ actor: { slug: "joe" } }),
          }),
        );
        await page.route("**/*", (route) =>
          route.request().resourceType() !== "document"
            ? route.fallback()
            : route.fulfill({
                contentType: "text/html",
                body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/app-shell.css"></head><body><div id="appShell"></div><main><h1>Navigation fixture</h1></main></body></html>',
              }),
        );
        const open = async (pathname: string) => {
          await page.goto(`${server.origin}${pathname}`);
          await page.evaluate(async (theme) => {
            document.documentElement.dataset.theme = theme;
            const modulePath: string = "/js/app-shell.js";
            await import(modulePath);
          }, theme);
          await page.getByRole("button", { name: "Joe: account and settings", exact: true }).waitFor();
        };
        await open("/deals");
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
        const links = page.locator(".app-shell-navigation > a");
        const expected = navigationItems.filter(
          (item) => !item.group && (width > 760 || !["/vendors", "/control-room"].includes(item.href)),
        );
        assert.equal(await links.first().getAttribute("href"), "/deals", "Deals is the first ordinary destination");
        assert.deepEqual(
          await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href"))),
          expected.map((item) => item.href),
        );
        let previous = -Infinity;
        for (const item of expected) {
          const link = page.getByRole("link", { name: item.label, exact: true });
          assert.equal(await link.locator(".app-shell-nav-label").isVisible(), true);
          assert.equal((await link.locator(".app-shell-nav-label").textContent())?.trim(), item.label);
          const box = await link.boundingBox();
          assert.ok(box);
          const position = width === 390 ? box.x : box.y;
          assert.ok(position > previous, "visual order matches DOM order");
          previous = position;
        }
        await links.first().focus();
        for (const item of expected) {
          assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), item.label);
          await page.keyboard.press("Tab");
        }
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "More");
        assert.equal(
          await page.getByRole("link", { name: "Local Deals", exact: true }).getAttribute("aria-current"),
          "page",
        );
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `/tmp/WR591.S1.J1-shots/${width}-${theme}.png` });
        await page.getByRole("button", { name: "More", exact: true }).click();
        const more = navigationItems.filter(
          (item) => item.group || (width === 390 && ["/vendors", "/control-room"].includes(item.href)),
        );
        assert.deepEqual(
          await page
            .locator(".app-shell-more-list a")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href"))),
          more.map((item) => item.href),
        );
        await page.keyboard.press("Escape");
        assert.equal(
          await page.getByRole("button", { name: "More", exact: true }).getAttribute("aria-expanded"),
          "false",
        );
        await open("/");
        assert.equal(await page.getByRole("link", { name: "Home", exact: true }).getAttribute("aria-current"), "page");
        await open("/relationships");
        const toggle = page.getByRole("button", { name: "More", exact: true });
        assert.match((await toggle.getAttribute("class")) ?? "", /app-shell-more-current/);
        await toggle.click();
        assert.equal(
          await page.getByRole("link", { name: "Relationships", exact: true }).getAttribute("aria-current"),
          "page",
        );
      } finally {
        await page.close();
      }
    }
  });
}
