import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildArtifact } from "../scripts/artifact.mjs";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { comparePhoneBaseline, phoneBaselineRows } from "../scripts/phone-target-baseline.ts";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium } from "./browser-harness.mjs";

test("Home audit rejects a new unreachable target at 390px", async (t) => {
  const root = await temporaryDirectory("review-837-obstructed-", t);
  await buildArtifact({ root: process.cwd(), outDir: root, commit: "1".repeat(40) });
  const server = await (await createQaServer({ buildRoot: `${root}/site` })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
  await page.addInitScript(() =>
    localStorage.setItem(
      "doctorcre.visual-preferences",
      JSON.stringify({ theme: "light", walkthroughSeen: { joe: true, dell: true } }),
    ),
  );
  await page.request.post(`${server.origin}/api/test/seed`, { data: { namespace: "review-obstructed", reset: true } });
  await page.goto(server.origin);
  await page.locator(".inbox-row").first().waitFor();
  const observe = async () =>
    phoneBaselineRows([{ ...(await inspectPhoneAccessibility(page)), name: "Home", width: 390, theme: "light" }]);
  const baseline = JSON.parse(await readFile("contracts/phone-target-baseline.json", "utf8")).filter(
    (x) => x.surface === "Home" && x.theme === "light",
  );
  assert.deepEqual(comparePhoneBaseline(await observe(), baseline), []);
  await page.evaluate(() => {
    const target = document.createElement("button");
    target.id = "review-blocked";
    target.textContent = "Review blocked";
    target.style.cssText = "position:fixed;left:20px;top:200px;width:60px;height:60px;z-index:2147483646";
    target.onclick = () => Reflect.set(window, "reviewTapped", 1);
    document.body.append(target);
    const cover = document.createElement("div");
    cover.id = "review-cover";
    cover.style.cssText =
      "position:fixed;left:20px;top:200px;width:60px;height:60px;background:white;z-index:2147483647";
    document.body.append(cover);
  });
  await page.touchscreen.tap(50, 230);
  const actual = await page.evaluate(() => ({
    tapped: Reflect.get(window, "reviewTapped") || 0,
    hit: document.elementFromPoint(50, 230)?.id,
    visible: document.getElementById("review-blocked")?.checkVisibility(),
    box: document.getElementById("review-blocked")?.getBoundingClientRect().toJSON(),
  }));
  const failures = comparePhoneBaseline(await observe(), baseline);
  console.log(JSON.stringify({ actual, failures }));
  assert.equal(actual.tapped, 0);
  assert.equal(actual.hit, "review-cover");
  assert.ok(failures.length, "The phone audit must fail for a new unreachable Home button");
});
