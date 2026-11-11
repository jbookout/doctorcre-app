import assert from "node:assert/strict";
import test from "node:test";
import { buildArtifact } from "../scripts/artifact.mjs";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
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
  const observe = () => inspectPhoneAccessibility(page);
  assert.deepEqual((await observe()).covered, []);
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
  const failures = await observe();
  assert.equal(actual.tapped, 0);
  assert.equal(actual.hit, "review-cover");
  assert.ok(failures.covered.some((target) => target.id === "review-blocked"));
  await page.locator("#review-cover").evaluate((node) => node.remove());
  assert.deepEqual((await observe()).covered, []);
  await page.touchscreen.tap(50, 230);
  assert.equal(await page.evaluate(() => Reflect.get(window, "reviewTapped")), 1);
});

test("Hit testing uses the visible clipped center and the handler owner's descendants", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.setContent(`<main>
    <div id="delegated" onclick="void 0" style="width:60px;height:60px"><span style="display:block;width:60px;height:60px">Tap</span></div>
    <section style="overflow:hidden;width:20px;height:60px"><button id="clipped" style="width:60px;height:60px">Clip</button></section>
    <button id="below" style="position:absolute;top:2000px;width:60px;height:60px">Below</button>
    <button id="covered" style="position:fixed;left:200px;top:200px;width:60px;height:60px">Covered</button>
    <div style="position:fixed;left:200px;top:200px;width:60px;height:60px;background:white"></div>
    <button id="no-pointer" style="pointer-events:none;width:60px;height:60px">No pointer</button>
    <div id="shadow"></div>
  </main>`);
  await page.locator("#shadow").evaluate((node) => {
    node.attachShadow({ mode: "open" }).innerHTML =
      '<button id="shadow-button" style="width:60px;height:60px">Shadow</button>';
  });
  const audit = await inspectPhoneAccessibility(page);
  assert.deepEqual(audit.covered.map((target) => target.id).sort(), ["covered", "no-pointer"]);
  assert.equal(audit.small.find((target) => target.id === "clipped")?.width, 20);
  assert.equal(await page.evaluate(() => scrollY), 0, "Inspection restores the initial scroll position");
});

test("Scroll-triggered list replacement retains the current logical target", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.setContent(
    '<button id="replaced" style="position:absolute;top:2000px;width:60px;height:60px">Open</button>',
  );
  await page.evaluate(() => {
    window.addEventListener(
      "scroll",
      () => {
        const node = document.getElementById("replaced");
        const replacement = node?.cloneNode(true);
        if (node && replacement instanceof HTMLElement) {
          replacement.dataset.replaced = "true";
          node.replaceWith(replacement);
        }
      },
      { once: true },
    );
  });
  const audit = await inspectPhoneAccessibility(page);
  assert.equal(await page.locator("#replaced").getAttribute("data-replaced"), "true");
  assert.deepEqual(audit.covered, []);
});

test("Scroll replacement measures the current activation area", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.setContent(
    '<button id="replaced" style="position:absolute;top:2000px;width:60px;height:60px">Open</button>',
  );
  await page.evaluate(() => {
    window.addEventListener(
      "scroll",
      () => {
        const node = document.getElementById("replaced");
        const replacement = node?.cloneNode(true);
        if (node && replacement instanceof HTMLElement) {
          replacement.style.width = "43px";
          node.replaceWith(replacement);
        }
      },
      { once: true },
    );
  });
  const audit = await inspectPhoneAccessibility(page);
  assert.equal(audit.small.find((target) => target.id === "replaced")?.width, 43);
});
