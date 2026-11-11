import assert from "node:assert/strict";
import test from "node:test";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { chromium } from "./browser-harness.mjs";

for (const top of [-100, 100])
  test(`Exclude noninteractive hidden small targets at top ${top}`, async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.route("http://hidden.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><title>Hidden controls</title></head><body><main><h1>Hidden targets</h1><style>button{width:20px;height:20px;min-width:0;min-height:0;padding:0}</style><button id="hidden" hidden>Hidden</button><button id="display" style="display:none">Display</button><button id="visibility" style="visibility:hidden">Visibility</button><button id="zero" style="width:0;height:0;border:0">Zero</button><button id="inert" inert style="position:absolute;top:${top}px">Inert</button><section inert style="position:absolute;top:${top}px"><div><button id="inert-child">Inert child</button></div></section><button id="visible">Visible</button></main></body></html>`,
      }),
    );
    await page.goto("http://hidden.test/");
    const audit = await inspectPhoneAccessibility(page);
    for (const id of ["hidden", "display", "visibility", "zero", "inert", "inert-child"])
      await t.test(id, () => assert.ok(!audit.small.some((x) => x.id === id), `${id} must be excluded`));
    assert.ok(audit.small.some((x) => x.id === "visible"));
  });

test("Physical clipping excludes resting skip navigation and focused navigation passes", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.setContent(`<style>
    .skip { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow:hidden; }
    .skip:focus { position: fixed; top: 0; width: 100px; height:44px; clip-path:none; }
    #touch { display: inline-block; width:20px; height:20px; }
  </style>
  <a id="keyboard" class="skip" href="#main">Skip to content</a>
  <a id="touch" class="skip-link" href="#main">Skip step</a>
  <main id="main" tabindex="-1">Content</main>`);
  const resting = await inspectPhoneAccessibility(page);
  assert.ok(!resting.small.some((row) => row.id === "keyboard"));
  assert.ok(!resting.covered.some((row) => row.id === "keyboard"));
  assert.ok(resting.small.some((row) => row.id === "touch"));
  await page.locator("#keyboard").focus();
  const focused = await inspectPhoneAccessibility(page);
  assert.ok(!focused.small.some((row) => row.id === "keyboard"));
  assert.ok(!focused.covered.some((row) => row.id === "keyboard"));
});
