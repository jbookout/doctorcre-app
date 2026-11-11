import assert from "node:assert/strict";
import test from "node:test";
import { assertQuietVendorBehavior } from "../scripts/prove-quiet-vendors-malformed-snapshot.ts";
import { chromium } from "./browser-harness.mjs";
import { ownedFixtureServer as fixtureServer } from "./fixture-probe.ts";

for (const width of [390, 1280])
  for (const theme of ["light", "dark"] as const) {
    test(`malformed quiet vendors recover at ${width}px ${theme}`, async (t) => {
      const server = await fixtureServer();
      t.after(() => server.close());
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route(`${server.origin}/quiet-proof`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/app.css"></head><body></body></html>`,
        }),
      );
      await page.goto(`${server.origin}/quiet-proof`);
      const results = await assertQuietVendorBehavior(page);
      assert.ok(results.includes("disposed ignores late read"));
      assert.deepEqual(errors, []);
    });
  }
