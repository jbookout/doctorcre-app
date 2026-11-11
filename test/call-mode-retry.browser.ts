import assert from "node:assert/strict";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { chromium } from "./browser-harness.mjs";

test("Shell Retry declares its button owner and reconnects from text, decoration and keyboard", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const activation of ["text", "decoration", "keyboard"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
    await page.addInitScript(() =>
      localStorage.setItem(
        "doctorcre.visual-preferences",
        JSON.stringify({ walkthroughSeen: { joe: true, dell: true } }),
      ),
    );
    await page.route("**/auth/session", (route) =>
      route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
    );
    let probes = 0;
    await page.route("http://127.0.0.1:4682/**", (route) => {
      probes++;
      return route.fulfill({ json: { state: "idle" } });
    });
    await page.route("**/retry-test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/app-shell.css"></head><body><div id="appShell"></div><script type="module" src="/js/app-shell.js"></script></body></html>',
      }),
    );
    await page.goto(`${server.origin}/retry-test`);
    await page.waitForFunction(() => typeof document.getElementById("callModeRetry")?.onclick === "function");
    const retry = page.locator("#callModeRetry");
    assert.equal(await page.locator("#callModeAvailability").textContent(), "Call recorder not connected");
    assert.equal(probes, 0, "Mounting does not contact the recorder");
    if (activation === "decoration")
      await retry.evaluate((node) => {
        node.innerHTML = "<span>Retry</span>";
      });
    await page.locator("#selfAvatar").click();
    for (const reverse of [false, false, true]) {
      const audit = await inspectPhoneAccessibility(page, page.mainFrame(), reverse);
      assert.ok(!audit.small.some((target) => target.id === "callModeRetry"));
      assert.ok(!audit.covered.some((target) => target.id === "callModeRetry"));
    }
    const box = await retry.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44);
    if (activation === "keyboard") {
      await retry.focus();
      await page.keyboard.press("Enter");
    } else await (activation === "decoration" ? retry.locator("span") : retry).tap();
    await page.waitForFunction(() => !document.getElementById("callModeButton")?.hidden);
    assert.equal(probes, 1, "Retry probes once and reveals Call Mode");
    assert.equal(await retry.isHidden(), true);
    if (activation === "keyboard")
      assert.equal(await page.locator("#callModeButton").evaluate((node) => document.activeElement === node), true);
    await page.close();
  }
});
