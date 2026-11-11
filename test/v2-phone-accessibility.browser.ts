import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { buildArtifact } from "../scripts/artifact.mjs";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { walkV2Accessibility } from "../scripts/v2-accessibility-walk.ts";
import { chromium } from "./browser-harness.mjs";
import { detail, tourId } from "./fixtures/tour-day.synthetic.mjs";

test("V2 surfaces fit phone and desktop in both accessible themes", async (t) => {
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
  assert.deepEqual(
    results.filter(
      (row) =>
        row.overflow ||
        row.clipped.length ||
        row.violations.length ||
        row.positiveTabindex.length ||
        row.focusOrder.some((focus) => !focus.visibleFocus),
    ),
    [],
    `Layout, WCAG and sampled keyboard focus. See ${shots}/results.json`,
  );
  assert.deepEqual(
    results.filter((row) => row.width === 390 && row.small.length),
    [],
    "Every phone target is at least 44 px",
  );
  await t.test(
    "Desktop calendar and sidebar targets still require 44 px sizing",
    { todo: "WR591.S37 remaining desktop layout work" },
    () => {
      assert.deepEqual(
        results.filter((row) => row.width === 1440 && row.small.length),
        [],
      );
    },
  );
});
