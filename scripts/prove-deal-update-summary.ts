import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseDealUpdateSummary, type UpdateSummary } from "../src/ui/deal-update-summary-model.ts";
import { prove } from "./prove-activity-attribution-panel.mjs";
export function compareSummary(
  expected: UpdateSummary,
  observed: { text: string; revision: string; partial: boolean; coverage: string; ids: string[] },
) {
  assert.equal(observed.text, expected.summary.text);
  assert.equal(observed.revision, expected.source_revision);
  assert.equal(observed.partial, !expected.coverage.complete);
  const coverage =
    (expected.coverage.complete
      ? "Summary covers all recorded supported updates."
      : `Partial summary · ${expected.coverage.covered_count} source statements quoted. Older updates or longer text may be omitted.`) +
    (expected.coverage.unsupported_events_present
      ? " History covers notes, activities and supported deal changes only; other event fields are not included."
      : " History covers notes, activities and supported deal changes.");
  assert.equal(observed.coverage, coverage);
  assert.deepEqual(
    observed.ids,
    expected.history.entries.map((e) => `${e.source}:${e.id}`),
  );
}
export async function proveSummary(options: {
  origin: string;
  expectedCommit: string;
  cdpUrl?: string | undefined;
  dealId?: string | undefined;
  fixtureCase?: string | undefined;
  timeoutMs?: number;
}) {
  if (options.fixtureCase) {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(options.origin).hostname) ||
      !["pass", "fail"].includes(options.fixtureCase)
    )
      return {
        status: "insufficient_evidence",
        exitCode: 78,
        error: "Fixture proof requires loopback and pass or fail",
      };
    const raw = JSON.parse(
      await readFile(new URL("../contracts/deal-update-summary.v1/fixture.json", import.meta.url), "utf8"),
    );
    const expected = parseDealUpdateSummary(raw, raw.deal_id);
    return prove({
      origin: options.origin,
      expectedCommit: options.expectedCommit,
      readRelease: async () => ({ source_commit: options.expectedCommit }),
      contains: async () => {},
      engine: { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) },
      observe: async () => {
        compareSummary(expected, {
          text: options.fixtureCase === "pass" ? expected.summary.text : (expected.history.entries[0]?.text ?? ""),
          revision: expected.source_revision,
          partial: !expected.coverage.complete,
          coverage:
            "Partial summary · 3 source statements quoted. Older updates or longer text may be omitted. History covers notes, activities and supported deal changes only; other event fields are not included.",
          ids: expected.history.entries.map((e) => `${e.source}:${e.id}`),
        });
        return { scope: "registered producer contract comparison only" };
      },
    });
  }
  return prove({
    ...options,
    observe: async (page, origin) => {
      if (!options.cdpUrl || !options.dealId)
        throw Object.assign(Error("Existing signed-in session and multi-update deal required"), { exitCode: 78 });
      for (const width of [1440, 390])
        for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(new URL(`/deals?deal=${encodeURIComponent(options.dealId)}`, origin).href);
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          const readExpected = async (cursor?: string) => {
            try {
              const raw: unknown = await page.evaluate(
                async (args) => {
                  const modulePath = "/js/deal-timeline.js";
                  const { createDealSummaryRead } = await import(modulePath);
                  return createDealSummaryRead()(args);
                },
                { deal_id: options.dealId, page_size: 50, ...(cursor ? { cursor } : {}) },
              );
              return parseDealUpdateSummary(raw, options.dealId ?? "");
            } catch {
              throw Object.assign(Error("Independent summary contract unavailable or source changed"), {
                exitCode: 78,
              });
            }
          };
          const expected = await readExpected();
          if (expected.history.entries.length < 2)
            throw Object.assign(Error("Multi-update deal evidence required"), { exitCode: 78 });
          const root = page.locator("#panelUpdateSummary");
          await page.waitForFunction(() =>
            Boolean(document.querySelector("#panelUpdateSummary")?.getAttribute("data-source-revision")),
          );
          if ((await root.getAttribute("data-source-revision")) !== expected.source_revision)
            throw Object.assign(Error("Source changed during proof"), { exitCode: 78 });
          const control = root.locator(".updates-history > summary");
          await control.focus();
          await page.keyboard.press("Enter");
          await root.locator(".deal-note").first().waitFor();
          compareSummary(expected, {
            text: (await root.locator("[data-summary]").textContent()) ?? "",
            revision: (await root.getAttribute("data-source-revision")) ?? "",
            partial: ((await root.locator("[data-coverage]").textContent()) ?? "").startsWith("Partial summary"),
            coverage: (await root.locator("[data-coverage]").textContent()) ?? "",
            ids: await root
              .locator(".deal-note")
              .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-id") ?? "")),
          });
          if (expected.history.next_cursor) {
            const next = await readExpected(expected.history.next_cursor);
            if (next.source_revision !== expected.source_revision)
              throw Object.assign(Error("Source changed during proof"), { exitCode: 78 });
            await root.getByRole("button", { name: "Load older updates" }).click();
            await page.waitForFunction(
              (count) => document.querySelectorAll("#panelUpdateSummary .deal-note").length === count,
              expected.history.entries.length + next.history.entries.length,
            );
            assert.deepEqual(
              await root.locator(".deal-note").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-id"))),
              [...expected.history.entries, ...next.history.entries].map((e) => `${e.source}:${e.id}`),
            );
          }
          await control.focus();
          await page.keyboard.press("Enter");
          assert.equal(await control.evaluate((n) => n === document.activeElement), true);
          await page.keyboard.press("Enter");
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
      return {
        scope: "natural same-deal summary, coverage, exact first and next page, focus and reopen at four viewports",
      };
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      origin: { type: "string", default: "https://app.doctorcre.com" },
      "expected-commit": { type: "string" },
      "cdp-url": { type: "string" },
      "deal-id": { type: "string" },
      "fixture-case": { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const result = await proveSummary({
    origin: values.origin,
    expectedCommit: values["expected-commit"] ?? "",
    cdpUrl: values["cdp-url"],
    dealId: values["deal-id"],
    fixtureCase: values["fixture-case"],
    timeoutMs: Number(values["timeout-ms"] ?? 30000),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
