import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { packetFixturePdf } from "../scripts/packet-fixture.ts";
import { observePacketPreview } from "../scripts/prove-packet-facts.ts";
import { chromium } from "./browser-harness.mjs";
import packet from "./fixtures/packet-parity/share.json" with { type: "json" };

const html = await readFile(new URL("../tours/packet-preview.html", import.meta.url), "utf8");
const css = await readFile(new URL("../tours/packet-preview.css", import.meta.url), "utf8");
const tokens = await readFile(new URL("../css/tokens.css", import.meta.url), "utf8");
const pdf = Buffer.from(await packetFixturePdf());
const sourceAssets = await appAssetSnapshot();
const code = sourceAssets.get("/js/ui-packet-preview.js")?.body;
const workerCode = sourceAssets.get("/js/ui-packet-worker.js")?.body;
assert.ok(code && workerCode);
const job = "55555555-5555-4555-8555-555555555555";
test("preview embeds the approved download bytes at desktop and phone widths", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const violations: string[] = [];
    await page.exposeFunction("recordPacketCsp", (directive: string) => violations.push(directive));
    await page.addInitScript(() =>
      addEventListener("securitypolicyviolation", (event) => {
        Reflect.get(window, "recordPacketCsp")(event.violatedDirective);
      }),
    );
    const reads: string[] = [];
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const moduleAsset = sourceAssets.get(url.pathname);
      if (moduleAsset && url.pathname.endsWith(".js")) return route.fulfill(moduleAsset);
      if (url.pathname === "/js/ui-packet-worker.js")
        return route.fulfill({ contentType: "text/javascript", body: workerCode });
      if (url.pathname === "/api/tours/pdf/download") {
        reads.push(url.search);
        return route.fulfill({ contentType: "application/pdf", body: pdf });
      }
      if (url.pathname === "/js/ui-packet-preview.js")
        return route.fulfill({ contentType: "text/javascript", body: code });
      if (url.pathname === "/js/theme-boot.js") return route.fulfill({ contentType: "text/javascript", body: "" });
      if (url.pathname === "/css/tokens.css") return route.fulfill({ contentType: "text/css", body: tokens });
      if (url.pathname.endsWith(".css")) return route.fulfill({ contentType: "text/css", body: css });
      return route.fulfill({
        contentType: "text/html",
        body: html,
        headers: {
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self' data:; img-src 'self' data: blob:",
        },
      });
    });
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`https://app.test/tours/packet-preview.html?render_job_id=${job}`);
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await page.waitForFunction(
          (count) => document.querySelectorAll('canvas[data-rendered="true"]').length === count,
          packet.stops.length + 1,
        );
        assert.doesNotMatch(await page.locator("#packet-preview").innerHTML(), /\bstyle\s*=/i);
        assert.doesNotMatch(
          (await page.locator("#packet-preview").textContent()) || "",
          /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
        );
        assert.equal(
          await page.locator("#packet-preview a").getAttribute("href"),
          `/api/tours/pdf/download?render_job_id=${job}`,
        );
        if (width === 390) {
          const text = page.locator("details").first();
          assert.equal(
            await text.getAttribute("open"),
            "",
            "Phone page text starts readable without opening a disclosure",
          );
          assert.ok(
            await text.locator("p").evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize) >= 16),
          );
          assert.ok(
            await text.evaluate((node) => {
              const canvas = node.parentElement?.querySelector("canvas");
              return !!canvas && node.getBoundingClientRect().bottom <= canvas.getBoundingClientRect().top;
            }),
          );
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.ok(
          await page
            .locator("canvas")
            .first()
            .evaluate((node) => node instanceof HTMLCanvasElement && node.width > 0),
        );
        await page.getByRole("button", { name: "Zoom in", exact: true }).first().click();
        assert.equal(
          await page.getByRole("button", { name: "Fit page", exact: true }).first().getAttribute("aria-pressed"),
          "true",
        );
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.getByRole("button", { name: "Fit page", exact: true }).first().click();
        if (process.env.PACKET_PARITY_SHOTS) {
          await mkdir(process.env.PACKET_PARITY_SHOTS, { recursive: true });
          await page.screenshot({
            path: `${process.env.PACKET_PARITY_SHOTS}/preview-${width}-${theme}.png`,
            fullPage: true,
          });
        }
      }
    assert.deepEqual(violations, []);
    assert.deepEqual(reads, Array(4).fill(`?render_job_id=${job}`));
  } finally {
    await browser.close();
  }
});
test("a refused artifact shows unavailable without embedding a document", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => {
      const path = new URL(route.request().url()).pathname;
      const moduleAsset = sourceAssets.get(path);
      if (moduleAsset && path.endsWith(".js")) return route.fulfill(moduleAsset);
      if (path === "/api/tours/pdf/download") return route.fulfill({ status: 403 });
      if (path === "/js/ui-packet-preview.js") return route.fulfill({ contentType: "text/javascript", body: code });
      if (path.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: "" });
      return route.fulfill({ contentType: "text/html", body: html });
    });
    await page.goto(`https://app.test/tours/packet-preview.html?render_job_id=${job}`);
    await page.getByText("This packet is unavailable. Return to Tours and refresh.", { exact: true }).waitFor();
    assert.equal(await page.locator("canvas").count(), 0);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
    assert.equal(await page.locator("#packet-preview").textContent(), "");
  } finally {
    await browser.close();
  }
});

test("the public packet renders the same synthetic stop facts at both widths", async () => {
  const { appAssetSnapshot } = await import("../scripts/fixture-app-assets.mjs");
  const { observePdf, comparePacketStops } = await import("../scripts/packet-pdf-observation.ts");
  const assets = await appAssetSnapshot();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      history.replaceState(
        { doctorcreShare: "projection:public:synthetic_projection", doctorcreShareContext: "synthetic-exchange" },
        "",
      );
      localStorage.setItem("doctorcre-public-share-context-v1", "synthetic-exchange");
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const moduleAsset = sourceAssets.get(url.pathname);
      if (moduleAsset && url.pathname.endsWith(".js")) return route.fulfill(moduleAsset);
      const payload =
        url.pathname === "/api/share/report"
          ? packet
          : url.pathname === "/api/share/map"
            ? { points: [] }
            : url.pathname === "/api/share/feedback"
              ? { projection_ref: "projection:public:synthetic_projection", permission_scopes: [], items: [] }
              : null;
      if (payload) return route.fulfill({ json: { data: payload } });
      const alias: Record<string, string> = {
        "/": "/reports/share.html",
        "/share.js": "/reports/share.js",
        "/share.css": "/reports/share.css",
        "/share-bootstrap.js": "/reports/share-bootstrap.js",
      };
      const asset = assets.get(alias[url.pathname] || url.pathname);
      return asset ? route.fulfill(asset) : route.abort();
    });
    const pdfStops = await observePdf(pdf);
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("https://reports.test/");
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await page.locator(".report-item dd").first().waitFor();
        assert.doesNotMatch((await page.locator("body").textContent()) || "", /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
        const share = await page.locator(".report-item").evaluateAll((nodes) =>
          nodes.map((node) => ({
            property: node.getAttribute("data-property-ref") || "",
            label: node.querySelector(".route-label")?.textContent || "",
            name: node.querySelector("h3")?.textContent || "",
            address: node.querySelector("h3 + p")?.textContent || "",
            facts: Array.from(node.querySelectorAll("dd"), (fact) => fact.textContent || ""),
            brand: node.ownerDocument.querySelector(".masthead > .eyebrow")?.textContent || "",
            appointment: node.querySelector(".packet-appointment")?.textContent || "",
            note: node.querySelector(".packet-public-note")?.textContent || "",
            asOf: node.querySelector(".packet-as-of")?.textContent || "",
          })),
        );
        if (width === 390) {
          assert.ok(
            await page
              .locator(".report-item dd")
              .first()
              .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize) >= 16),
          );
          assert.ok(
            await page
              .locator(".packet-appointment")
              .first()
              .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize) >= 16),
          );
          assert.doesNotMatch(await page.locator("#report-list").innerHTML(), /\bstyle\s*=/i);
        }
        comparePacketStops(pdfStops, pdfStops, share);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.PACKET_PARITY_SHOTS)
          await page.screenshot({
            path: `${process.env.PACKET_PARITY_SHOTS}/share-${width}-${theme}.png`,
            fullPage: true,
          });
      }
  } finally {
    await browser.close();
  }
});

test("leaving a rendered preview closes its worker and clears packet content", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => {
      const path = new URL(route.request().url()).pathname;
      const moduleAsset = sourceAssets.get(path);
      if (moduleAsset && path.endsWith(".js")) return route.fulfill(moduleAsset);
      if (path === "/api/tours/pdf/download") return route.fulfill({ contentType: "application/pdf", body: pdf });
      if (path === "/js/ui-packet-preview.js") return route.fulfill({ contentType: "text/javascript", body: code });
      if (path === "/js/ui-packet-worker.js")
        return route.fulfill({ contentType: "text/javascript", body: workerCode });
      if (path.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: "" });
      return route.fulfill({ contentType: "text/html", body: html });
    });
    await page.goto(`https://app.test/tours/packet-preview.html?render_job_id=${job}`);
    await page.waitForFunction(
      (count) => document.querySelectorAll('canvas[data-rendered="true"]').length === count,
      packet.stops.length + 1,
    );
    const worker = page.workers()[0];
    assert.ok(worker);
    const closed = worker.waitForEvent("close");
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
    await closed;
    assert.equal(await page.locator("#packet-preview").textContent(), "");
    assert.equal(page.workers().length, 0);
  } finally {
    await browser.close();
  }
});

test("a late packet response cannot reopen a preview after leaving", async () => {
  const browser = await chromium.launch();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let handled = () => {};
  const finished = new Promise<void>((resolve) => {
    handled = resolve;
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const moduleAsset = sourceAssets.get(path);
      if (moduleAsset && path.endsWith(".js")) return route.fulfill(moduleAsset);
      if (path === "/api/tours/pdf/download") {
        await gate;
        try {
          await route.fulfill({ contentType: "application/pdf", body: pdf });
        } finally {
          handled();
        }
        return;
      }
      if (path === "/js/ui-packet-preview.js") return route.fulfill({ contentType: "text/javascript", body: code });
      if (path.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: "" });
      return route.fulfill({ contentType: "text/html", body: html });
    });
    const request = page.waitForRequest("**/api/tours/pdf/download?*");
    await page.goto(`https://app.test/tours/packet-preview.html?render_job_id=${job}`);
    await request;
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
    release();
    await finished;
    assert.equal(await page.locator("#packet-preview").textContent(), "");
    assert.equal(page.workers().length, 0);
  } finally {
    release();
    await browser.close();
  }
});

test("packet proof waits for the final PDF page after every property stop is counted", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/tours/pdf/download") return route.fulfill({ contentType: "application/pdf", body: pdf });
      const asset = sourceAssets.get(path);
      return asset ? route.fulfill(asset) : route.abort();
    });
    await page.addInitScript(() => {
      const postMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, options) {
        const transfer = Array.isArray(options) ? { transfer: options } : options;
        if (message?.action === "GetOperatorList" && message.data?.pageIndex === 2) {
          Reflect.set(window, "releaseFinalPacketPage", () => postMessage.call(this, message, transfer));
          return;
        }
        return postMessage.call(this, message, transfer);
      };
    });
    await page.goto(`https://app.test/tours/packet-preview.html?render_job_id=${job}`);
    await page.waitForFunction(() => document.querySelectorAll('canvas[data-rendered="true"]').length === 2);
    await page.waitForFunction(() => typeof Reflect.get(window, "releaseFinalPacketPage") === "function");
    assert.equal(await page.locator("canvas").nth(2).getAttribute("data-rendered"), null);
    let ready = false;
    const observation = observePacketPreview(page, pdf).then((stops) => {
      ready = true;
      return stops;
    });
    try {
      await assert.rejects(
        page.waitForFunction(() => false, undefined, { timeout: 500 }),
        /Timeout/,
      );
      assert.equal(ready, false, "two property stops cannot certify all three PDF pages ready");
    } finally {
      await page.waitForFunction(() => typeof Reflect.get(window, "releaseFinalPacketPage") === "function");
      await page.evaluate(() => Reflect.get(window, "releaseFinalPacketPage")());
      assert.equal((await observation).length, packet.stops.length);
    }
    assert.equal(ready, true);
    assert.equal(await page.locator('canvas[data-rendered="true"]').count(), 3);
    assert.equal((await observePacketPreview(page, pdf)).length, packet.stops.length);
  } finally {
    await browser.close();
  }
});
