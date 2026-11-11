import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { chromium } from "./browser-harness.mjs";

const execute = promisify(execFile);
test("Inspector measures the same-origin tour frame rather than only the parent", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://phone.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: route.request().url().endsWith("/frame")
        ? '<!doctype html><html lang="en"><head><title>Tour</title></head><body><main><h1>Tour</h1><button style="height:20px">Small frame target</button></main></body></html>'
        : '<!doctype html><iframe title="Tour" src="/frame"></iframe>',
    }),
  );
  await page.goto("http://phone.test/");
  await page.frameLocator("iframe").getByRole("button").waitFor();
  const frame = page.frames().find((frame) => frame.url().endsWith("/frame"));
  assert.ok(frame);
  assert.equal((await inspectPhoneAccessibility(page)).small.length, 0, "Parent audit excludes nested-frame targets");
  const result = await inspectPhoneAccessibility(page, frame);
  assert.equal(result.small.length, 1);
  assert.equal(result.small[0]?.text, "Small frame target");
});
for (const fixture of ["pass", "fail"])
  test(`V2 phone proof CLI ${fixture} fixture`, async () => {
    const command = [
      "scripts/prove-v2-phone-accessibility.ts",
      "--expected-commit",
      "1111111111111111111111111111111111111111",
      "--fixture-case",
      fixture,
    ];
    if (fixture === "pass") {
      const result = await execute(process.execPath, command);
      assert.equal(JSON.parse(result.stdout).exitCode, 0);
    } else {
      await assert.rejects(execute(process.execPath, command), (error: unknown) => {
        assert.ok(error && typeof error === "object" && "code" in error && error.code === 1);
        return true;
      });
    }
  });

test("Browser audit enforces new, smaller and fixed baseline targets", async (t) => {
  const { phoneBaselineRows, comparePhoneBaseline } = await import("../scripts/phone-target-baseline.ts");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.setContent('<button id="fixture" style="width:20px;height:20px;padding:0;border:0">Open</button>');
  const observe = async () =>
    phoneBaselineRows([{ ...(await inspectPhoneAccessibility(page)), name: "Fixture", width: 390, theme: "light" }]);
  const baseline = await observe();
  assert.equal(baseline[0]?.width, 20);
  assert.deepEqual(comparePhoneBaseline(baseline, baseline), []);
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "new";
    button.style.cssText = "width:20px;height:20px;padding:0;border:0";
    button.textContent = "New";
    document.body.append(button);
  });
  assert.match(comparePhoneBaseline(await observe(), baseline).join("\n"), /New undersized target/);
  await page.locator("#new").evaluate((node) => node.remove());
  await page.locator("#fixture").evaluate((node) => {
    node.style.height = "19px";
  });
  assert.match(comparePhoneBaseline(await observe(), baseline).join("\n"), /got smaller/);
  await page.locator("#fixture").evaluate((node) => {
    node.style.width = "44px";
    node.style.height = "44px";
  });
  assert.match(comparePhoneBaseline(await observe(), baseline).join("\n"), /Remove fixed/);
  assert.deepEqual(comparePhoneBaseline(await observe(), []), []);
});
