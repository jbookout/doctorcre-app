import assert from "node:assert/strict";
import test from "node:test";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { chromium } from "./browser-harness.mjs";

test("Exclude noninteractive hidden small targets", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.route("http://hidden.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><title>Hidden controls</title></head><body><main><h1>Hidden targets</h1><style>button{width:20px;height:20px;min-width:0;min-height:0;padding:0}</style><button id="hidden" hidden>Hidden</button><button id="display" style="display:none">Display</button><button id="visibility" style="visibility:hidden">Visibility</button><button id="zero" style="width:0;height:0;border:0">Zero</button><button id="inert" inert style="position:absolute;top:-100px">Inert</button><section inert style="position:absolute;top:-100px"><button id="inert-child">Inert child</button></section><button id="visible">Visible</button></main></body></html>`,
    }),
  );
  await page.goto("http://hidden.test/");
  const audit = await inspectPhoneAccessibility(page);
  for (const id of ["hidden", "display", "visibility", "zero", "inert", "inert-child"])
    await t.test(id, () => assert.ok(!audit.small.some((x) => x.id === id), `${id} must be excluded`));
  assert.ok(audit.small.some((x) => x.id === "visible"));
});
