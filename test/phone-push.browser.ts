import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

test("phone push controls at phone and desktop sizes in both themes", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("out/test-artifacts/phone-push", { recursive: true });
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      try {
        await page.route("**/push-test.html", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/notifications.css"></head><body><main id="test" class="shell"></main></body></html>',
          }),
        );
        await page.goto(`${server.origin}/push-test.html`);
        await page.evaluate(async (theme) => {
          document.documentElement.dataset.theme = theme;
          const { mountPhonePush } = await import("/js/ui-phone-push.js");
          const root = document.querySelector("#test");
          if (!root) throw Error("Missing test host");
          const calls: string[] = [];
          const view = mountPhonePush(root, {
            installation: "11111111-1111-4111-8111-111111111111",
            supported: () => true,
            permission: () => "granted",
            requestPermission: async () => {
              calls.push("permission");
              return "granted";
            },
            subscribe: async () => ({
              endpoint: "https://web.push.apple.com/synthetic",
              p256dh: "synthetic",
              auth: "synthetic",
            }),
            unsubscribe: async () => {
              calls.push("unsubscribe");
              return true;
            },
            call: async (verb, args) => {
              calls.push(verb);
              return {
                ok: true,
                schema_version: "web-push-registry.v1",
                replayed: false,
                installation_id: args.installation_id,
                generation: verb.startsWith("register") ? 1 : 2,
                state: verb.startsWith("register") ? "active" : "revoked",
              };
            },
            changed() {},
          });
          Reflect.set(window, "pushCalls", calls);
          Reflect.set(window, "pushView", view);
        }, theme);
        assert.equal(await page.evaluate(() => Reflect.get(window, "pushCalls").length), 0);
        await page.getByRole("button", { name: "Enable phone notifications" }).click();
        await page.getByRole("button", { name: "Disable phone notifications" }).waitFor();
        assert.match((await page.getByRole("status").textContent()) ?? "", /enabled on this installation/);
        await page.screenshot({ path: `out/test-artifacts/phone-push/${width}-${theme}.png` });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.getByRole("button", { name: "Disable phone notifications" }).click();
        await page.getByRole("button", { name: "Enable phone notifications" }).waitFor();
        const calls: unknown = await page.evaluate(() => Reflect.get(window, "pushCalls"));
        assert.deepEqual(calls, [
          "permission",
          "register-web-push-subscription-v1",
          "revoke-web-push-subscription-v1",
          "unsubscribe",
        ]);
        await page.evaluate(() => Reflect.get(window, "pushView").retire());
        await page.getByText("Session ended. Sign in again to manage this installation.").waitFor();
        assert.equal(await page.getByRole("button").isDisabled(), true);
      } finally {
        await page.close();
      }
    }
});
