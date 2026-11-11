import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { webkit } from "playwright";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { chromium } from "./browser-harness.mjs";

const cases = [
  ["hidden", false, "<button hidden>Hidden</button>"],
  ["display", false, '<button style="display:none">Display</button>'],
  ["visibility", false, '<button style="visibility:hidden">Visibility</button>'],
  ["zero", false, '<button style="width:0;height:0;border:0">Zero</button>'],
  ["inert", false, "<button inert>Inert</button>"],
  ["inert-child", false, "<section inert><button>Inert child</button></section>"],
  [
    "closed-details",
    false,
    '<details><summary id="closed-summary">Summary</summary><button>Closed details</button></details>',
  ],
  ["closed-dialog", false, "<dialog><button>Closed dialog</button></dialog>"],
  ["popover", false, "<section popover><button>Popover</button></section>"],
  ["until-found", false, '<section hidden="until-found"><button>Until found</button></section>'],
  [
    "content-visibility",
    false,
    '<section style="content-visibility:hidden"><button>Content visibility</button></section>',
  ],
  ["aria-hidden", true, '<section aria-hidden="true"><button>ARIA hidden</button></section>'],
  ["opacity", true, '<button style="opacity:0">Opacity</button>'],
  ["above", true, '<button style="position:absolute;top:-100px">Above</button>'],
  ["below", true, '<button style="position:absolute;top:2000px">Below</button>'],
  ["open-details", true, "<details open><summary>Summary</summary><button>Open details</button></details>"],
  ["open-dialog", true, "<dialog open><button>Open dialog</button></dialog>"],
  ["tour-day-link", true, '<a href="#tour" style="position:absolute;top:-200px">Navigate tour</a>'],
  ["onclick-div", true, '<div onclick="window.tapped=1" style="width:20px;height:20px">Tap</div>'],
  [
    "open-shadow",
    true,
    `<div id="shadow-host" style="width:100px;height:100px"></div><script>document.getElementById("shadow-host").attachShadow({mode:"open"}).innerHTML='<button id="open-shadow" style="width:20px;height:20px;padding:0">Tap</button>'</script>`,
  ],
  [
    "delegated",
    false,
    '<ul onclick="window.tapped=1" style="width:20px;height:20px"><li><button id="delegated-button">Tap</button></li></ul>',
  ],
  ["disabled", false, "<button disabled>Disabled</button>"],
  [
    "partial-clip",
    true,
    '<section style="overflow:hidden;width:20px;height:60px"><button style="width:60px;height:60px">Partial</button></section>',
  ],
  [
    "scrolled",
    false,
    '<section style="overflow:auto;width:100px;height:50px"><p style="height:100px;margin:0"></p><button style="width:60px;height:60px">Scrolled</button></section>',
  ],
  [
    "sr-only",
    false,
    '<label id="sr-only" for="sr-input" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Search</label><input id="sr-input" style="width:60px;height:60px">',
  ],
] as const;

test("Browser authority determines phone target membership across 25 reachability cases", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.route("http://reachability.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><title>Reachability matrix</title><style>button,summary,a{width:20px;height:20px;min-width:0;min-height:0;padding:0}</style></head><body><main><h1>Reachability</h1>${cases.map(([id, , html]) => (id === "open-shadow" ? html : html.replace(/<(button|a|div|ul)\b/, `<$1 id="${id}"`))).join("")}</main></body></html>`,
    }),
  );
  await page.goto("http://reachability.test/");
  await page.locator("#scrolled").evaluate((node) => {
    if (node.parentElement) node.parentElement.scrollTop = 100;
  });
  const audit = await inspectPhoneAccessibility(page);
  for (const [id, expected] of cases)
    await t.test(id, () => {
      assert.equal(
        audit.small.some((target) => target.id === id),
        expected,
        `${id} membership`,
      );
    });
  await t.test("delegated button is counted without its list", () => {
    assert.ok(audit.small.some((target) => target.id === "delegated-button"));
    assert.ok(!audit.small.some((target) => target.tag === "UL"));
  });
  await t.test("partial clip reports the visible 20 px box", () => {
    assert.equal(audit.small.find((target) => target.id === "partial-clip")?.width, 20);
  });
  await t.test("closed-details summary remains reachable", () => {
    assert.ok(audit.small.some((target) => target.id === "closed-summary"));
  });
});

test("Phone inspector explicitly refuses WebKit", { skip: !existsSync(webkit.executablePath()) }, async (t) => {
  const browser = await webkit.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await assert.rejects(inspectPhoneAccessibility(page), /requires Chromium/);
});

test("Native date-control accessibility children measure their rendered host once", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://date.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><title>Date targets</title></head><body><main><h1>Date</h1><input id="date" aria-label="Date" type="date" style="height:20px"></main></body></html>',
    }),
  );
  await page.goto("http://date.test/");
  const audit = await inspectPhoneAccessibility(page);
  assert.equal(audit.small.length, 1);
  assert.equal(audit.small[0]?.id, "date");
});

test("Phone candidates include each activation listener without a role or native control", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const events = ["click", "pointerdown", "pointerup", "touchstart", "touchend"];
  await page.setContent(events.map((event) => `<div id="${event}" style="width:20px;height:20px">Tap</div>`).join(""));
  await page.evaluate((events) => {
    for (const event of events) document.getElementById(event)?.addEventListener(event, () => {});
  }, events);
  const audit = await inspectPhoneAccessibility(page);
  assert.deepEqual(audit.small.map((target) => target.id).sort(), events.sort());
});

for (const kind of ["hidden-child", "sr-only"])
  test(kind, async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
    await page.setContent(
      `<html lang="en"><head><title>Probe</title><style>label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style></head><body><main><h1>Probe</h1>${kind === "hidden-child" ? '<div id="target" onclick="window.tapped=1" style="width:20px;height:20px;background:red"><button hidden>Hidden</button></div>' : '<label id="clipped" for="q">Search</label><input id="q" style="width:100px;height:50px">'}</main></body></html>`,
    );
    const audit = await inspectPhoneAccessibility(page);
    if (kind === "hidden-child") {
      const box = await page.locator("#target").boundingBox();
      assert.ok(box);
      await page.touchscreen.tap(box.x + 10, box.y + 10);
      assert.equal(await page.evaluate(() => (window as unknown as { tapped: number }).tapped), 1);
      console.log(JSON.stringify({ kind, box, tapped: 1, small: audit.small }));
      assert.ok(
        audit.small.some((x) => x.id === "target"),
        "Reachable 20px container must be counted",
      );
    } else {
      console.log(JSON.stringify({ kind, small: audit.small }));
      assert.ok(!audit.small.some((x) => x.id === "clipped"), "Clipped label is not a physical tap target");
    }
  });
