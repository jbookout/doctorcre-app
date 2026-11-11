import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

test("Client view renders server-only content at 390 and 1440 in light and dark", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("/tmp/WR586.S4.J15-shots", { recursive: true });
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      try {
        await page.route("**/client-view-test.html", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/pipeline.css"><main id="view" style="padding:16px"></main>',
          }),
        );
        await page.goto(`${server.origin}/client-view-test.html`);
        await page.evaluate(async (theme) => {
          document.documentElement.dataset.theme = theme;
          const ui = await import("/js/ui-client-publications.js");
          const element = document.querySelector("#view");
          if (!element) throw Error("Missing host");
          const fixture = ui.createPublicationFixture();
          Reflect.set(
            window,
            "clientView",
            ui.mountClientPublications(element, {
              dealId: "11111111-1111-4111-8111-111111111111",
              request: async (name, args, options) =>
                name === "list-deal-deliverables"
                  ? {
                      ok: true,
                      schema_version: "deal-deliverables.v1",
                      deliverables: [
                        {
                          id: "44444444-4444-4444-8444-444444444444",
                          deal_id: "11111111-1111-4111-8111-111111111111",
                          filename: "Final report " + "x".repeat(199) + "😀.pdf",
                          mime: "application/pdf",
                          bytes: 500,
                          sha256: "a".repeat(64),
                          state: "finalized",
                          visibility: "shared",
                          version: 7,
                        },
                      ],
                    }
                  : fixture(name, args, options),
            }),
          );
        }, theme);
        await page.getByRole("button", { name: "Publish", exact: true }).waitFor();
        assert.doesNotMatch((await page.locator("[data-client-preview]").textContent()) ?? "", /Site visit scheduled/);
        await page.getByRole("button", { name: "Publish", exact: true }).click();
        await page.getByRole("button", { name: "Unpublish", exact: true }).waitFor();
        assert.match((await page.locator("[data-client-preview]").textContent()) ?? "", /Site visit scheduled/);
        await page.screenshot({ path: `/tmp/WR586.S4.J15-shots/${width}-${theme}.png`, fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        for (const button of await page.getByRole("button").all()) {
          const box = await button.boundingBox();
          if (box) assert.ok(box.x >= 0 && box.x + box.width <= width, "control fits viewport");
        }
        await page.getByRole("button", { name: "Unpublish", exact: true }).click();
        await page.getByRole("button", { name: "Publish", exact: true }).waitFor();
        assert.doesNotMatch((await page.locator("[data-client-preview]").textContent()) ?? "", /Site visit scheduled/);
      } finally {
        await page.close();
      }
    }
});

test("deal workspace opens Client view without replacing Documents or Tours", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  try {
    await page.goto(`${server.origin}/deals?deal=d14&tab=client-view`);
    await page.getByRole("heading", { name: "Client view", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("tab", { name: "Client view", exact: true }).getAttribute("aria-selected"),
      "true",
    );
    const activeTab = await page.getByRole("tab", { name: "Client view", exact: true }).boundingBox();
    assert.ok(
      activeTab && activeTab.x >= 0 && activeTab.x + activeTab.width <= 390,
      "selected Client view tab fits the phone viewport",
    );
    assert.equal(await page.getByRole("tab", { name: "Documents", exact: true }).count(), 1);
    assert.equal(await page.getByRole("tab", { name: "Tours", exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: "/tmp/WR586.S4.J15-shots/390-workspace.png", fullPage: true });
  } finally {
    await page.close();
  }
});
