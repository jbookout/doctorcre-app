import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { observeV2Accessibility } from "../scripts/prove-v2-phone-accessibility.ts";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
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

test("Absolute inspection rejects existing offender shrink and passes only at 44", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  for (const width of [41.9375, 43, 20, 10, 44]) {
    await page.setContent(`<button id="fixture" style="width:${width}px;height:44px;padding:0;border:0">Open</button>`);
    const result = await inspectPhoneAccessibility(page);
    assert.equal(result.small.length, width < 44 ? 1 : 0);
    assert.deepEqual(result.covered, []);
  }
});

test("Proof refuses a rendered theme mismatch as an assertion failure", async (t) => {
  const root = await temporaryDirectory("phone-proof-theme-", t);
  const server = await (await createQaServer()).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() =>
    localStorage.setItem(
      "doctorcre.visual-preferences",
      JSON.stringify({ theme: "dark", walkthroughSeen: { joe: true, dell: true } }),
    ),
  );
  await page.request.post(`${server.origin}/api/test/seed`, { data: { namespace: "phone-proof-theme", reset: true } });
  await assert.rejects(observeV2Accessibility(page, server.origin, root), (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError);
    assert.match(error.message, /requested theme/);
    return true;
  });
});
