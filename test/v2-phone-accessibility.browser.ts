import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { buildArtifact } from "../scripts/artifact.mjs";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { assertPhoneTargets } from "../scripts/phone-target-contract.ts";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { walkV2Accessibility } from "../scripts/v2-accessibility-walk.ts";
import { chromium } from "./browser-harness.mjs";
import { detail, tourId } from "./fixtures/tour-day.synthetic.mjs";

test("V2 phone targets have zero undersized or covered controls in both themes", { timeout: 600_000 }, async (t) => {
  const root = await temporaryDirectory("v2-phone-a11y-", t);
  await buildArtifact({ root: process.cwd(), outDir: root, commit: "1".repeat(40) });
  const server = await (await createQaServer({ buildRoot: `${root}/site` })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const shots = process.env.PHONE_A11Y_SHOTS || `${root}/shots`;
  await mkdir(shots, { recursive: true });
  const results: (Awaited<ReturnType<typeof walkV2Accessibility>>[number] & { width: number; theme: string })[] = [];
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      await page.addInitScript(
        (theme) =>
          localStorage.setItem(
            "doctorcre.visual-preferences",
            JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } }),
          ),
        theme,
      );
      await page.request.post(`${server.origin}/api/test/seed`, {
        data: { namespace: `phone-${width}-${theme}`, reset: true },
      });
      const recording = JSON.parse(
        await readFile(new URL("./fixtures/vendor-meetings/recordings.json", import.meta.url), "utf8"),
      );
      await page.route("**/mcp", (route) => {
        const request = route.request().postDataJSON();
        if (request.params?.name !== "read-vendor-meetings") return route.fallback();
        return route.fulfill({
          json: {
            jsonrpc: "2.0",
            id: request.id,
            result: { content: [{ type: "text", text: JSON.stringify(recording[request.params.arguments.view]) }] },
          },
        });
      });
      await page.route("**/api/tours/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/tours/library")
          return route.fulfill({
            json: {
              data: { tours: [{ id: tourId, name: detail.name, status: "draft" }] },
              csrf_token: "synthetic-session",
            },
          });
        if (path === "/api/tours/detail")
          return route.fulfill({
            json: {
              data: {
                ...detail,
                stops: detail.routes[0].stops.map((stop) => ({ ...stop, locked_appointment: false })),
                routes: [
                  {
                    ...detail.routes[0],
                    stops: detail.routes[0].stops.map((stop) => ({ ...stop, locked_appointment: false })),
                  },
                ],
                route_version_id: detail.routes[0].id,
                route_version_state: "accepted",
                accepted_route_version: 1,
              },
              csrf_token: "synthetic-session",
            },
          });
        return route.fallback();
      });
      const rows = await walkV2Accessibility(page, server.origin, async (name) => {
        await page.screenshot({ path: `${shots}/${name}-${width}-${theme}.png`, fullPage: true });
        await writeFile(`${shots}/${name}-${width}-${theme}.aria.txt`, await page.locator("body").ariaSnapshot());
        if (name === "Home") {
          const checkbox = page.locator('.inbox-row input[type="checkbox"]').first();
          const graphic = await checkbox.boundingBox();
          assert.ok(graphic && graphic.width <= 22 && graphic.height <= 22, "Checkbox artwork stays compact");
          const label = await checkbox.locator("..").boundingBox();
          assert.ok(label && label.width >= 44 && label.height >= 44, "Checkbox label owns the larger activation area");
        }
        if (width === 390 && name === "Tours library") {
          const layout = await page.locator('label[for="tour-filter"]').evaluate((label) => {
            const text = document.createRange();
            text.selectNodeContents(label.firstChild || label);
            const input = label.querySelector("input");
            if (!input) throw Error("Tour filter input is missing");
            return {
              text: text.getBoundingClientRect().toJSON(),
              input: input.getBoundingClientRect().toJSON(),
              lineHeight: parseFloat(getComputedStyle(label).lineHeight),
            };
          });
          assert.ok(layout.text.bottom <= layout.input.top, "Find a tour sits above its input");
          assert.ok(layout.text.height <= layout.lineHeight + 1, "Find a tour stays on one line");
        }
        if (width === 390 && name === "Vendors Suggested") {
          const box = await page.locator('label[for="searchInput"]').boundingBox();
          assert.equal(box?.width, 1, "Search label keeps its original sr-only width");
          assert.equal(box?.height, 1, "Search label keeps its original sr-only height");
        }
        if (name === "Tour and cheat sheet") {
          const editing = page.locator("#route-editing");
          if (!(await editing.evaluate((node) => node instanceof HTMLDetailsElement && node.open)))
            await editing.locator(":scope > summary").click();
          const first = page.locator("#route-stops .composer-stop").first();
          const property = await first.getAttribute("data-property-id");
          await first.getByRole("button", { name: "Down", exact: true }).focus();
          await page.keyboard.press("Enter");
          assert.equal(
            await page.locator("#route-stops .composer-stop").last().getAttribute("data-property-id"),
            property,
            "Keyboard reorder moves the first property down",
          );
          if (width === 390 && theme === "light") {
            await t.test("Phone audit catches a 20 px Navigate tour link above the viewport", async () => {
              const link = page.locator("#tour-day-link");
              const originalStyle = await link.getAttribute("style");
              try {
                await link.evaluate((node) => {
                  node.style.setProperty("height", "20px", "important");
                  node.style.setProperty("min-height", "20px", "important");
                  node.style.setProperty("padding", "0", "important");
                  window.scrollTo(0, document.documentElement.scrollHeight);
                });
                const box = await link.evaluate((node) => node.getBoundingClientRect().toJSON());
                assert.equal(box.height, 20);
                assert.ok(box.bottom < 0, "Navigate tour is rendered above the current viewport");
                const audit = await inspectPhoneAccessibility(page);
                assert.ok(
                  audit.small.some((target) => target.id === "tour-day-link" && target.height === 20),
                  "The audit reports the undersized Navigate tour link regardless of scroll position",
                );
              } finally {
                await link.evaluate((node, style) => {
                  if (style === null) node.removeAttribute("style");
                  else node.setAttribute("style", style);
                }, originalStyle);
              }
            });
          }
          const dragHandles = await page.locator("#route-stops [draggable=true]").count();
          await writeFile(
            `${shots}/reorder-${width}-${theme}.json`,
            JSON.stringify({ keyboardReorder: "passed", dragHandles }),
          );
        }
      });
      results.push(...rows.map((row) => ({ ...row, width, theme })));
      await page.close();
    }
  await writeFile(`${shots}/results.json`, JSON.stringify(results, null, 2));
  assertPhoneTargets(results);
});
