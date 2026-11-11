import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Page } from "playwright";
import { inspectPhoneAccessibility } from "./phone-accessibility.ts";
import { assertPhoneTargets } from "./phone-target-contract.ts";
import { prove } from "./prove-activity-attribution-panel.mjs";
import { walkV2Accessibility } from "./v2-accessibility-walk.ts";

export async function observeV2Accessibility(page: Page, origin: string, shots: string) {
  await mkdir(shots, { recursive: true });
  const results = [];
  await page.goto(origin);
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme === "dark" ? "dark" : "light" });
      await page.evaluate(
        (theme) =>
          localStorage.setItem(
            "doctorcre.visual-preferences",
            JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } }),
          ),
        theme,
      );
      let rows: Awaited<ReturnType<typeof walkV2Accessibility>>;
      try {
        rows = await walkV2Accessibility(page, origin, async (name) => {
          assert.equal(
            await page.evaluate(() => document.documentElement.dataset.theme),
            theme,
            "Proof observes the requested theme",
          );
          await page.screenshot({ path: `${shots}/${name}-${width}-${theme}.png`, fullPage: true });
        });
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        throw Object.assign(
          Error(`Populated signed-in surface unavailable: ${error instanceof Error ? error.message : String(error)}`),
          { exitCode: 78 },
        );
      }
      results.push(...rows.map((row) => ({ ...row, width, theme })));
    }
  assertPhoneTargets(results);
  return { results, scope: "Absolute 44 px activation areas and unobstructed visible centers." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      origin: { type: "string", default: "https://app.doctorcre.com" },
      "expected-commit": { type: "string" },
      "cdp-url": { type: "string" },
      shots: { type: "string", default: "/tmp/v2-phone-accessibility-proof" },
      "timeout-ms": { type: "string", default: "600000" },
      "fixture-case": { type: "string" },
    },
  });
  const result = await prove({
    origin: values.origin,
    expectedCommit: values["expected-commit"] || "",
    cdpUrl: values["cdp-url"],
    timeoutMs: Number(values["timeout-ms"]),
    ...(values["fixture-case"]
      ? {
          readRelease: async () => ({ source_commit: values["expected-commit"] || "" }),
          contains: async (commit: string, observed: string) => {
            assert.equal(commit, observed);
          },
        }
      : {}),
    observe: async (page: Page, origin: string) => {
      if (!values["fixture-case"]) return observeV2Accessibility(page, origin, values.shots);
      assert.ok(["pass", "fail"].includes(values["fixture-case"]), "Unknown fixture case");
      await page.route("http://phone.test/", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html lang="en"><head><title>Phone proof fixture</title></head><body><main><h1>Phone proof</h1><button style="width:100px;height:${values["fixture-case"] === "pass" ? 44 : 43}px;color:black;background:white">Open</button></main></body></html>`,
        }),
      );
      await page.goto("http://phone.test/");
      const result = await inspectPhoneAccessibility(page);
      assert.equal(result.small.length, 0, "Fixture control has a 44 px target");
      assert.equal(result.covered.length, 0, "Fixture center hits its target");
      assert.equal(result.violations.length, 0, "Fixture has no WCAG violations");
      return { scope: "Synthetic inspector fixture only", result };
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
