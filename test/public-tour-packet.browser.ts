import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { AxeResults } from "axe-core";
import axe from "axe-core";
import { buildArtifact } from "../scripts/artifact.mjs";
import { assertPublishedPacketPdf } from "../scripts/public-tour-pdf-proof.ts";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { parsePublicTourPacket } from "../src/ui/public-tour-packet.ts";
import { chromium } from "./browser-harness.mjs";

const recorded = JSON.parse(await readFile(new URL("./fixtures/tour-packet/response.json", import.meta.url), "utf8"));
const stops = parsePublicTourPacket(recorded);
recorded.stops = stops.map((stop) => ({ ...stop, broker_notes: "PRIVATE_SENTINEL" }));
test("public packet renders three stops, map and PDF in the same order at both widths and themes", async (t) => {
  const outDir = temporaryDirectory("public-tour-packet-");
  const browser = await chromium.launch();
  let server: { origin: string; close(): Promise<void> } | undefined;
  t.after(async () => {
    await browser.close();
    await server?.close();
    await rm(outDir, { recursive: true, force: true });
  });
  await buildArtifact({ root: new URL("../", import.meta.url).pathname, outDir, commit: "0".repeat(40) });
  server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  for (const width of [1440, 390])
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme });
      await page.route("**/api/share/report", (route) => route.fulfill({ json: { data: recorded } }));
      await page.route("**/api/share/map", (route) =>
        route.fulfill({
          json: {
            data: {
              points: stops.map((stop) => ({
                property_ref: stop.property_ref,
                route_sequence: stop.route_sequence,
                route_label: stop.route_label,
                latitude: 30.4 + stop.route_sequence * 0.01,
                longitude: -87.2 + stop.route_sequence * 0.01,
              })),
            },
          },
        }),
      );
      await page.route("**/api/share/exchange", (route) => route.fulfill({ json: { data: {} } }));
      await page.request.post(`${server.origin}/api/test/seed`, { data: { namespace: "tour-packet", reset: true } });
      await page.goto(`${server.origin}/share#${"a".repeat(43)}`);
      await page.getByRole("button", { name: "Open tour", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Report and map loaded.");
      assert.deepEqual(
        await page.locator(".report-item h3").allTextContents(),
        [1, 2, 3].map((n) => `Example ${n}`),
      );
      assert.deepEqual(await page.locator(".maplibregl-marker").allTextContents(), ["1", "2", "3"]);
      assert.equal(await page.getByText("Unknown", { exact: true }).count(), 15);
      assert.equal(await page.locator("body").evaluate((el) => el.textContent.includes("PRIVATE_SENTINEL")), false);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.waitForFunction(
        () => {
          const markers = [...document.querySelectorAll(".maplibregl-marker")];
          const controls = [...document.querySelectorAll(".maplibregl-ctrl button")];
          return markers.every((marker) =>
            controls.every((control) => {
              const a = marker.getBoundingClientRect(),
                b = control.getBoundingClientRect();
              return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
            }),
          );
        },
        undefined,
        { timeout: 2000 },
      );
      await mkdir("/tmp/WR12.S1.J6-shots", { recursive: true });
      await page.screenshot({ path: `/tmp/WR12.S1.J6-shots/${width}-${colorScheme}.png`, fullPage: true });
      await page.evaluate(axe.source);
      const accessibility = await page.evaluate<AxeResults>("axe.run(document.querySelector('.report-list'))");
      assert.deepEqual(accessibility.violations, []);
      await page.emulateMedia({ media: "print" });
      assert.equal(await page.locator(".maplibregl-marker:visible").count(), 3);
      assert.deepEqual(
        await page.locator(".report-item h3").allTextContents(),
        [1, 2, 3].map((n) => `Example ${n}`),
      );
      const pdf = await page.pdf({ path: `/tmp/WR12.S1.J6-shots/${width}-${colorScheme}.pdf`, tagged: true });
      assert.ok(pdf.length > 10000);
      await assertPublishedPacketPdf(pdf, parsePublicTourPacket(recorded));
      assert.equal((pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 4);
      assert.equal(await page.locator(".packet-notes:visible").count(), 3);
      await page.close();
    }
  for (const transition of [
    "Opening to Ready: approved facts and matching map arrive",
    "Opening to Empty: read or parity check fails",
    "Ready to PrintDialog: Save PDF",
    "PrintDialog to Ready: Close print dialog",
    "Ready to Empty: access changes",
    "PrintDialog to Empty: access changes",
  ]) {
    await t.test(transition, async () => {
      assert.ok(server);
      const page = await browser.newPage();
      try {
        await page.route("**/api/share/report", (route) => route.fulfill({ json: { data: recorded } }));
        await page.route("**/api/share/map", (route) =>
          route.fulfill({
            json: {
              data: {
                points: transition.startsWith("Opening to Empty")
                  ? []
                  : stops.map((stop) => ({ ...stop, latitude: 30.4, longitude: -87.2 })),
              },
            },
          }),
        );
        await page.route("**/api/share/exchange", (route) => route.fulfill({ json: { data: {} } }));
        await page.request.post(`${server.origin}/api/test/seed`, { data: { namespace: "tour-packet", reset: true } });
        await page.goto(`${server.origin}/share#${"a".repeat(43)}`);
        await page.locator("#open-tour").click();
        if (transition.startsWith("Opening to Empty")) {
          await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("unavailable"));
          assert.equal(await page.locator(".report-item").count(), 0);
          assert.equal(await page.locator("#print-packet").isVisible(), false);
          return;
        }
        await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Report and map loaded.");
        await page.evaluate(() => {
          document.documentElement.dataset.printCalls = "0";
          window.print = () => {
            document.documentElement.dataset.printCalls = String(
              Number(document.documentElement.dataset.printCalls) + 1,
            );
            window.dispatchEvent(new Event("beforeprint"));
          };
        });
        if (transition.startsWith("PrintDialog") || transition.startsWith("Ready to PrintDialog")) {
          await page.locator("#print-packet").click();
          assert.equal(await page.locator("html").getAttribute("data-print-calls"), "1");
        }
        if (transition.includes("Close print dialog")) {
          await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
          assert.equal(await page.locator(".report-item").count(), 3);
          assert.equal(await page.locator("#print-packet").isVisible(), true);
          await page.locator("#print-packet").click();
          assert.equal(await page.locator("html").getAttribute("data-print-calls"), "2");
        }
        if (transition.includes("access changes")) {
          const calls = await page.locator("html").getAttribute("data-print-calls");
          await page.evaluate(() => {
            window.dispatchEvent(
              new StorageEvent("storage", { key: "doctorcre-public-share-context-v1", newValue: "changed" }),
            );
            document.querySelector("#print-packet")?.dispatchEvent(new MouseEvent("click"));
            window.dispatchEvent(new Event("afterprint"));
          });
          assert.equal(await page.locator(".report-item").count(), 0);
          assert.equal(await page.locator("#print-packet").isVisible(), false);
          assert.equal(await page.locator("html").getAttribute("data-print-calls"), calls);
        } else {
          assert.equal(await page.locator(".report-item").count(), 3);
          assert.equal(await page.locator("#print-packet").isVisible(), true);
        }
      } finally {
        await page.close();
      }
    });
  }
  const page = await browser.newPage();
  await page.route("**/api/share/map", (route) => route.fulfill({ json: { data: { points: [] } } }));
  await page.route("**/api/share/exchange", (route) => route.fulfill({ json: { data: {} } }));
  await page.request.post(`${server.origin}/api/test/seed`, { data: { namespace: "tour-packet", reset: true } });
  await page.goto(`${server.origin}/share#${"a".repeat(43)}`);
  await page.getByRole("button", { name: "Open tour", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("unavailable"));
  assert.equal(await page.locator(".report-item").count(), 0);
  assert.equal(await page.locator("#print-packet").isVisible(), false);
  await page.close();
});
