import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";
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
    true,
    '<section style="overflow:auto;width:100px;height:100px"><p style="height:100px;margin:0"></p><button style="width:20px;height:60px">Scrolled</button></section>',
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
      body: `<!doctype html><html lang="en"><head><title>Reachability matrix</title><style>button,summary,a{width:20px;height:20px;min-width:0;min-height:0;padding:0}</style></head><body><main><h1>Reachability</h1>${cases.map(([id, , html]) => (["open-shadow", "sr-only"].includes(id) ? html : html.replace(/<(button|a|div|ul)\b/, `<$1 id="${id}"`))).join("")}</main></body></html>`,
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
  await t.test("scrolled button keeps its full rendered size", () => {
    const target = audit.small.find((target) => target.id === "scrolled");
    assert.equal(target?.width, 20);
    assert.equal(target?.height, 60);
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
      assert.equal(await page.evaluate(() => Reflect.get(window, "tapped")), 1);
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

test("Chromium clips target boxes through their own and ancestor clip paths", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<main>
    <button id="inset" style="width:60px;height:60px;clip-path:inset(0 40px 0 0)">Inset</button>
    <section style="clip-path:inset(50%)"><button id="ancestor">Hidden by ancestor</button></section>
    <button id="own-zero" style="clip-path:circle(0);width:60px;height:60px">Hidden by self</button>
    <section style="overflow:hidden;width:30px;height:60px"><section style="overflow:clip;width:20px;height:60px"><button id="nested" style="width:60px;height:60px">Nested</button></section></section>
    <button id="far" style="position:absolute;top:20000000px;width:20px;height:20px;padding:0">Far</button>
  </main>`);
  const audit = await inspectPhoneAccessibility(page);
  for (const id of ["inset", "nested", "far"])
    assert.equal(audit.small.find((target) => target.id === id)?.width, 20, `${id} visible width`);
  for (const id of ["ancestor", "own-zero"])
    assert.ok(!audit.small.some((target) => target.id === id), `${id} has no pointer area`);
});

test("Phone audit refuses coarse bounds when a nonrectangular clip may remove all pointer area", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<section style="width:100px;height:100px;clip-path:circle(50%)"><button style="width:10px;height:10px;padding:0">Clipped corner</button></section>',
  );
  await assert.rejects(inspectPhoneAccessibility(page), /exact nonrectangular clip-path geometry/);
});

test("Mixed delegated and native targets retain the real 20 px action", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
  await page.setContent(
    `<html lang="en"><head><title>Delegated target</title></head><body><main><h1>Targets</h1><ul id="owner" style="margin:0;padding:0;width:200px;height:100px"><li id="small" data-action="small" style="display:block;width:20px;height:20px;background:red">X</li><li style="display:block"><button style="width:60px;height:60px">Large</button></li></ul></main></body></html>`,
  );
  await page.evaluate(() =>
    document.getElementById("owner")?.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-action]")) Reflect.set(window, "tapped", true);
    }),
  );
  const box = await page.locator("#small").boundingBox();
  assert.ok(box);
  await page.touchscreen.tap(box.x + 10, box.y + 10);
  assert.equal(await page.evaluate(() => Reflect.get(window, "tapped")), true);
  for (const reverse of [false, false, true]) {
    const audit = await inspectPhoneAccessibility(page, page.mainFrame(), reverse);
    assert.equal(audit.small.find((target) => target.id === "small")?.width, 20);
    assert.deepEqual(audit.covered, []);
  }
});

for (const focusable of [false, true])
  test(`Delegated grandparent retains small action with focusable owner ${focusable}`, async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
    await page.setContent(
      `<html lang="en"><head><title>Delegated target</title></head><body><main><h1>Targets</h1><div id="owner" ${focusable ? 'tabindex="0"' : ""} style="width:200px;height:120px"><ul style="margin:0;padding:0"><li id="small" data-action="small" style="display:block;width:20px;height:20px;background:red"><span style="pointer-events:none">X</span></li><li style="display:block"><button style="width:60px;height:60px">Large</button></li></ul></div></main></body></html>`,
    );
    await page.evaluate(() =>
      document.getElementById("owner")?.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest("[data-action]"))
          Reflect.set(window, "tapped", true);
      }),
    );
    const box = await page.locator("#small").boundingBox();
    assert.ok(box);
    await page.touchscreen.tap(box.x + 10, box.y + 10);
    assert.equal(await page.evaluate(() => Reflect.get(window, "tapped")), true);
    for (const reverse of [false, false, true]) {
      const audit = await inspectPhoneAccessibility(page, page.mainFrame(), reverse);
      const small = audit.small.find((target) => target.id === "small");
      assert.equal(small?.width, 20, "real 20 px delegated action must be discovered");
      assert.equal(small?.height, 20);
      assert.deepEqual(audit.covered, []);
    }
  });

for (const size of [20, 60])
  for (const child of ["text", "decoration", "action"])
    test(`Self-listener button ownership with ${child} at ${size}px`, async (t) => {
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
      await page.setContent(
        `<main><button id="retry" style="width:${size}px;height:${size}px;padding:0">${child === "text" ? "Retry" : child === "decoration" ? "<span>Retry</span>" : '<span id="small" data-action="retry" style="display:block;width:20px;height:20px">X</span>'}</button></main>`,
      );
      await page.evaluate((child) => {
        const button = document.querySelector("button");
        if (!button) throw Error("Retry button missing");
        const call = {
          handleClick(target: EventTarget | null) {
            Reflect.set(window, "tapped", target instanceof Element ? target.id : "");
          },
        };
        button.onclick =
          child === "action"
            ? (event) => {
                if (event.target instanceof Element && event.target.closest("[data-action]"))
                  Reflect.set(window, "tapped", "small");
              }
            : (event) => call.handleClick(event.currentTarget);
      }, child);
      await page.locator(child === "action" ? "#small" : "#retry").tap();
      assert.equal(await page.evaluate(() => Reflect.get(window, "tapped")), child === "action" ? "small" : "retry");
      for (const reverse of [false, false, true]) {
        const audit = await inspectPhoneAccessibility(page, page.mainFrame(), reverse);
        if (child === "action") {
          assert.equal(audit.small.find((target) => target.id === "small")?.width, 20);
          assert.equal(audit.small.find((target) => target.id === "small")?.height, 20);
        } else if (size === 20) {
          assert.equal(audit.small.find((target) => target.id === "retry")?.width, 20);
          assert.equal(audit.small.find((target) => target.id === "retry")?.height, 20);
        } else {
          assert.deepEqual(audit.small, []);
        }
        assert.deepEqual(audit.covered, []);
      }
    });

test("Self-listener with an independently listening child refuses opaque forwarding", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<button id="owner" style="width:60px;height:60px"><span id="small" style="display:block;width:20px;height:20px">X</span></button>',
  );
  await page.evaluate(() => {
    const button = document.querySelector("button");
    const small = document.getElementById("small");
    if (!button || !small) throw Error("Targets missing");
    const call = {
      handleClick(target: EventTarget | null) {
        Reflect.set(window, "tapped", target);
      },
    };
    button.onclick = (event) => call.handleClick(event.target);
    small.addEventListener("click", () => Reflect.set(window, "childTapped", true));
  });
  await assert.rejects(inspectPhoneAccessibility(page), /unknown target dispatch semantics/);
});

for (const dispatch of ["dynamic selector", "target id"])
  test(`Unknown delegated dispatch refuses clean evidence: ${dispatch}`, async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(
      '<ul id="owner"><li id="small" style="width:20px;height:20px">Small</li><li><button style="width:60px;height:60px">Large</button></li></ul>',
    );
    await page.evaluate((dispatch) => {
      const selector = "#small";
      document.getElementById("owner")?.addEventListener(
        "click",
        dispatch === "dynamic selector"
          ? (event) => {
              if (event.target instanceof Element && event.target.closest(selector))
                Reflect.set(window, "tapped", true);
            }
          : (event) => {
              if (event.target instanceof Element && event.target.id === "small") Reflect.set(window, "tapped", true);
            },
      );
    }, dispatch);
    await assert.rejects(inspectPhoneAccessibility(page), /literal target selector|unknown target dispatch semantics/);
  });

for (const dispatch of ["aliased closest", "dataset"])
  test(`Delegated target ownership: ${dispatch}`, async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(
      '<ul id="owner"><li id="small" data-action="small" style="width:20px;height:20px">Small</li><li><button style="width:60px;height:60px">Large</button></li></ul>',
    );
    await page.evaluate((dispatch) => {
      document.getElementById("owner")?.addEventListener(
        "click",
        dispatch === "aliased closest"
          ? (event) => {
              const target = event.target;
              if (target instanceof Element && target.closest("[data-action]")) Reflect.set(window, "tapped", true);
            }
          : (event) => {
              if (event.target instanceof HTMLElement && event.target.dataset.action)
                Reflect.set(window, "tapped", true);
            },
      );
    }, dispatch);
    const audit = await inspectPhoneAccessibility(page);
    assert.equal(audit.small.find((target) => target.id === "small")?.width, 20);
  });

test("Opaque delegated helper refuses clean evidence", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<ul id="owner"><li id="small" style="width:20px;height:20px">Small</li><li><button style="width:60px;height:60px">Large</button></li></ul>',
  );
  await page.evaluate(() => {
    const activate = (event: Event) => {
      if (event.target instanceof Element && event.target.id === "small") Reflect.set(window, "tapped", true);
    };
    document.getElementById("owner")?.addEventListener("click", (event) => activate(event));
  });
  await assert.rejects(inspectPhoneAccessibility(page), /opaque delegated helper/);
});

test("React delegated pointer targets retain their declared activation area", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
  await page.setContent(
    '<html lang="en"><title>React targets</title><main><h1>Targets</h1><div id="root"></div></main></html>',
  );
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import {createElement as h} from 'react';
      import {createRoot} from 'react-dom/client';
      createRoot(document.getElementById('root')).render(h('ul', null,
        h('li', {id:'small', onPointerDown:()=>window.tapped=true, style:{width:20,height:20}}, 'Small'),
        h('li', null, h('button', {style:{width:60,height:60}}, 'Large'))));
    `,
    },
    bundle: true,
    write: false,
    format: "iife",
  });
  const script = bundle.outputFiles?.[0]?.text;
  assert.ok(script);
  await page.addScriptTag({ content: script });
  await page.locator("#small").waitFor();
  const box = await page.locator("#small").boundingBox();
  assert.ok(box);
  await page.touchscreen.tap(box.x + 10, box.y + 10);
  assert.equal(await page.evaluate(() => Reflect.get(window, "tapped")), true);
  const audit = await inspectPhoneAccessibility(page);
  assert.equal(audit.small.find((target) => target.id === "small")?.width, 20);
});

test("Opaque self-listener refuses an undiscovered child action", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
  await page.setContent(
    '<main><button id="owner" style="position:relative;width:100px;height:100px;padding:0"><span id="small" style="position:absolute;left:0;top:0;display:block;width:20px;height:20px">X</span></button></main>',
  );
  await page.evaluate(() => {
    Reflect.set(window, "taps", 0);
    const dispatch = (target: EventTarget | null) => {
      if (target instanceof Element && target.id === "small")
        Reflect.set(window, "taps", Reflect.get(window, "taps") + 1);
    };
    const owner = document.getElementById("owner");
    if (!owner) throw Error("Owner missing");
    owner.onclick = (event) => dispatch(event.target);
  });
  await page.locator("#small").tap();
  assert.equal(await page.evaluate(() => Reflect.get(window, "taps")), 1);
  await page.locator("#owner").tap();
  assert.equal(await page.evaluate(() => Reflect.get(window, "taps")), 1, "Owner center does not activate the child");
  for (const reverse of [false, false, true])
    await assert.rejects(
      inspectPhoneAccessibility(page, page.mainFrame(), reverse),
      /unknown target dispatch semantics/,
    );
});

test("Wrapper listener preserves its only small native button", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
  await page.setContent(
    '<main><div id="owner" style="width:200px;height:120px"><button id="small" style="width:20px;height:20px;padding:0">X</button></div></main>',
  );
  await page.evaluate(() =>
    document.getElementById("owner")?.addEventListener("click", () => Reflect.set(window, "tapped", true)),
  );
  await page.locator("#small").tap();
  assert.equal(await page.evaluate(() => Reflect.get(window, "tapped")), true);
  for (const reverse of [false, false, true]) {
    const audit = await inspectPhoneAccessibility(page, page.mainFrame(), reverse);
    assert.deepEqual(
      audit.small.map((target) => target.id),
      ["small"],
    );
    assert.equal(audit.small[0]?.width, 20);
    assert.equal(audit.small[0]?.height, 20);
    assert.deepEqual(audit.covered, []);
  }
});
