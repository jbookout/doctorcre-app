import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { exercise } from "../scripts/prove-email-deal-picker-auth-retirement.ts";
import { uiAssets } from "../scripts/ui-bundle.mjs";
import { chromium } from "./browser-harness.mjs";

const assets = await uiAssets((path) => readFile(path, "utf8"));
for (const width of [390, 1280])
  for (const theme of ["light", "dark"])
    test(`public email mount retires and recovers at ${width} in ${theme}`, async (t) => {
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.route("**/*", (route) => {
        const path = new URL(route.request().url()).pathname.slice(1);
        const body = assets.get(path);
        return route.fulfill(
          body
            ? { contentType: "text/javascript", body }
            : { contentType: "text/html", body: "<!doctype html><body></body>" },
        );
      });
      await page.goto("http://127.0.0.1/__email-proof__");
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      const assertions = await exercise(page, "http://127.0.0.1/js/ui-email-actions.generated.js");
      for (const error of [{ status: 401 }, { status: 403 }, { code: "session_changed" }]) {
        assert.ok(assertions.includes(`canceled board denial retires replacement ${JSON.stringify(error)}`));
      }
      assert.ok(assertions.includes("retired ignores late board"));
      assert.ok(assertions.includes("pending recovery replays identical request"));
    });
