import assert from "node:assert/strict";
import test from "node:test";
import { buildArtifact } from "../scripts/artifact.mjs";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium } from "./browser-harness.mjs";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

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

test("Geometry-time row replacement never reports the row covered by its own child", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const replacements of [1, 8, Infinity]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    try {
      await page.setContent(`<main><button style="width:60px;height:60px">First</button>
        <a href="#" id="row" class="record-row" style="position:absolute;top:2200px;left:13px;width:364px;height:162px;display:block"><span style="display:block;width:100%;height:100%">Demo Partner 30</span></a></main>`);
      await page.evaluate((limit) => {
        let count = 0;
        const observer = new IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting) || count >= limit) return;
          const row = document.getElementById("row");
          if (!row) throw Error("Missing fixture row");
          const replacement = row.cloneNode(true);
          if (!(replacement instanceof Element)) throw Error("Fixture replacement is not an element");
          row.replaceWith(replacement);
          count++;
          Reflect.set(window, "rowReplacements", count);
          observer.unobserve(row);
          observer.observe(replacement);
        });
        const row = document.getElementById("row");
        if (!row) throw Error("Missing fixture row");
        observer.observe(row);
      }, replacements);
      for (const reverse of [false, false, true]) {
        const result = await inspectPhoneAccessibility(page, page.mainFrame(), reverse).then(
          (audit) => ({ audit, error: null }),
          (error: unknown) => ({ audit: null, error }),
        );
        if (result.error) {
          assert.notEqual(replacements, 1, "One replacement must recover");
          assert.match(String(result.error), /unstable-identity/);
        } else {
          assert.deepEqual(result.audit?.covered, [], "Current row owns its center after geometry-time replacement");
        }
      }
      assert.ok((await page.evaluate(() => Number(Reflect.get(window, "rowReplacements")))) > 0);
    } finally {
      await page.close();
    }
  }
});

test("A replacement at the same selector with a different action refuses identity", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.setContent(
    '<a id="row" href="#original" style="position:absolute;top:2200px;width:100px;height:60px">Open</a>',
  );
  await page.evaluate(() => {
    const row = document.getElementById("row");
    if (!row) throw Error("Missing fixture row");
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      const replacement = row.cloneNode(true);
      if (!(replacement instanceof Element)) throw Error("Fixture replacement is not an element");
      replacement.setAttribute("href", "#different-action");
      row.replaceWith(replacement);
      observer.disconnect();
    });
    observer.observe(row);
  });
  await assert.rejects(inspectPhoneAccessibility(page), /unstable-identity after 3 attempts/);
  assert.equal(await page.locator("#row").getAttribute("href"), "#different-action");
});

test("Directory refresh across a minute preserves phone target identity", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-11T21:00:59Z") });
  const url = "http://localhost/api/v1/business/vendors/00000000-0000-4000-8000-000000000009";
  const before = directoryFixture(url);
  t.mock.timers.tick(2000);
  const after = directoryFixture(url);
  t.mock.timers.reset();
  assert.notDeepEqual(before.source, after.source, "Read freshness advances independently of record updates");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  assert.ok(before.record && typeof before.record === "object" && "updated_at" in before.record);
  assert.ok(after.record && typeof after.record === "object" && "updated_at" in after.record);
  await page.setContent(
    `<a id="row" href="#record" style="position:absolute;top:2200px;width:100px;height:60px">Updated ${before.record.updated_at}</a>`,
  );
  await page.evaluate((updated) => {
    window.addEventListener(
      "scroll",
      () => {
        const row = document.getElementById("row");
        if (!row) throw Error("Missing row");
        const replacement = row.cloneNode(true);
        replacement.textContent = `Updated ${updated}`;
        row.replaceWith(replacement);
      },
      { once: true },
    );
  }, after.record.updated_at);
  const audit = await inspectPhoneAccessibility(page);
  assert.deepEqual(audit.covered, []);
  assert.equal(await page.locator("#row").textContent(), `Updated ${after.record.updated_at}`);
});
