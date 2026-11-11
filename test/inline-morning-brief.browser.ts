import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import { ownedCdpFixture } from "./owned-cdp-fixture.ts";

test("Home brief stays inline with inbox and restores priority focus in both themes and widths", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    qaSeed: JSON.parse(await readFile(new URL("../data/board-seed.json", import.meta.url), "utf8")),
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("/tmp/WR591.S5.J1-shots", { recursive: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      try {
        await page.request.post(`${server.origin}/api/test/seed`, {
          data: { namespace: `inline-${width}-${theme}`, reset: true },
        });
        await page.goto(`${server.origin}/`);
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        const brief = page.locator("#homeBrief #docMorningBrief");
        if (width === 390) {
          const toggle = page.getByRole("button", { name: "Morning brief Open brief" });
          await toggle.waitFor();
          const firstRow = page.locator(".inbox-row").first();
          await firstRow.waitFor();
          await page.waitForFunction(() => {
            const mail = document.querySelector('.home-inbox > [aria-label="Mail priorities"]');
            return mail && getComputedStyle(mail).order === "1";
          });
          await page.evaluate(() => document.fonts.ready);
          const box = await firstRow.boundingBox();
          assert.ok(box && box.y < 750, "Inbox work is within the first phone screen");
          await toggle.click();
        }
        await brief.waitFor();
        await brief.locator("[data-brief-record]").first().waitFor();
        assert.equal(await page.locator("dialog[open]").count(), 0);
        assert.equal(await page.getByRole("region", { name: "Inbox cards", exact: true }).count(), 1);
        const checkbox = page.locator('.inbox-row input[type="checkbox"]').first();
        await checkbox.check();
        const editor = page.getByRole("button", { name: "Set waiting person", exact: true }).first();
        await editor.click();
        const reason = page.getByLabel("Reason", { exact: true }).first();
        await reason.fill("Keep this synthetic draft");
        const first = brief.locator("[data-brief-record]").first();
        const key = await first.getAttribute("data-brief-key");
        await first.click();
        await brief.locator(".morning-record").waitFor();
        await page.locator("#morningBack").click();
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-brief-key")), key);
        if (width === 390) {
          await page.locator("#morningRefresh").click();
          assert.equal(await page.locator(".home-brief-toggle").getAttribute("aria-expanded"), "true");
          await page.locator(".home-brief-toggle").click();
          assert.equal(await brief.isVisible(), false);
          await page.locator("#docMorning").evaluate((node: HTMLElement) => node.click());
          await brief.waitFor();
          assert.equal(await brief.isVisible(), true);
          assert.equal(await page.evaluate(() => document.activeElement?.id), "morningTitle");
        }
        assert.equal(await checkbox.isChecked(), true);
        assert.equal(await reason.inputValue(), "Keep this synthetic draft");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `/tmp/WR591.S5.J1-shots/${width}-${theme}.png`, fullPage: true });
      } finally {
        await page.close();
      }
    }
});

test("production proof observer accepts the fixture and refuses incorrect source text", async (t) => {
  const { observeInlineBrief } = await import("../scripts/prove-inline-morning-brief.ts");
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    qaSeed: JSON.parse(await readFile(new URL("../data/board-seed.json", import.meta.url), "utf8")),
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.request.post(`${server.origin}/api/test/seed`, { data: { namespace: "inline-proof", reset: true } });
  await observeInlineBrief(page, server.origin);
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const title = document.getElementById("morningTitle");
      if (title && title.textContent !== "Incorrect owner") title.textContent = "Incorrect owner";
    }).observe(document, { childList: true, subtree: true });
  });
  await assert.rejects(observeInlineBrief(page, server.origin), /Incorrect owner/);
});

test("inline brief proof CLI returns 0 and 1 with no borrowed-tab leak", async (t) => {
  const commit = "1".repeat(40);
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    qaSeed: JSON.parse(await readFile(new URL("../data/board-seed.json", import.meta.url), "utf8")),
    routes: new Map([
      [
        "/app-release",
        {
          contentType: "application/json",
          body: JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: commit }),
        },
      ],
    ]),
  });
  t.after(() => server.close());
  const fixture = await ownedCdpFixture();
  t.after(() => fixture.close());
  await fixture.context.request.post(`${server.origin}/api/test/seed`, {
    data: { namespace: "inline-cli", reset: true },
  });
  const before = fixture.context.pages().length;
  const args = [
    "scripts/prove-inline-morning-brief.ts",
    "--origin",
    server.origin,
    "--expected-commit",
    commit,
    "--cdp-url",
    fixture.endpoint,
    "--timeout-ms",
    "20000",
  ];
  const run = promisify(execFile);
  const result = JSON.parse((await run(process.execPath, args)).stdout);
  assert.equal(result.exitCode, 0);
  assert.equal(fixture.context.pages().length, before);
  await fixture.context.addInitScript(() => {
    new MutationObserver(() => {
      const title = document.getElementById("morningTitle");
      if (title && title.textContent !== "Incorrect owner") title.textContent = "Incorrect owner";
    }).observe(document, { childList: true, subtree: true });
  });
  await assert.rejects(run(process.execPath, args), (error) => {
    if (!error || typeof error !== "object" || !("code" in error)) return false;
    return error.code === 1;
  });
  assert.equal(fixture.context.pages().length, before);
});
