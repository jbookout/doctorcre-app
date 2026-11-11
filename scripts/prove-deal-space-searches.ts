import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseSearchResponse, type Search } from "../src/ui/deal-space-search-model.ts";
import { prove as runProof } from "./prove-activity-attribution-panel.mjs";

export function compareSearch(
  expected: Search,
  observed: { name: string; requirements: string; criteria: unknown; ids: string[] },
) {
  assert.equal(observed.name, expected.name);
  assert.equal(observed.requirements, expected.requirements);
  assert.deepEqual(observed.criteria, expected.criteria);
  assert.deepEqual(observed.ids, expected.result_property_ids);
}
export async function proveSearch(options: {
  origin: string;
  expectedCommit: string;
  cdpUrl?: string | undefined;
  dealId?: string | undefined;
  searchId?: string | undefined;
  fixtureCase?: string | undefined;
  timeoutMs?: number;
}) {
  if (options.fixtureCase) {
    const fixture = JSON.parse(
      await readFile(new URL("../test/fixtures/deal-space-searches/responses.json", import.meta.url), "utf8"),
    );
    return runProof({
      origin: options.origin,
      expectedCommit: options.expectedCommit,
      readRelease: async () => ({ source_commit: options.expectedCommit }),
      contains: async () => {},
      engine: { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) },
      observe: async () => {
        const expected = parseSearchResponse(fixture.positive, fixture.positive.search.deal_id)[0];
        assert.ok(expected);
        compareSearch(expected, {
          name: expected.name,
          requirements: expected.requirements,
          criteria: expected.criteria,
          ids: options.fixtureCase === "pass" ? expected.result_property_ids : [],
        });
        return { scope: "synthetic recorded producer response" };
      },
    });
  }
  return runProof({
    ...options,
    observe: async (page, origin) => {
      const uuid = /^[0-9a-f-]{36}$/i;
      if (
        !options.cdpUrl ||
        !options.dealId ||
        !options.searchId ||
        !uuid.test(options.dealId) ||
        !uuid.test(options.searchId)
      )
        throw Object.assign(Error("Signed-in CDP session, deal ID and saved search ID required"), { exitCode: 78 });
      await page.goto(`${origin}/deals?deal=${options.dealId}&tab=tours&tour=new`);
      const editor = page.frameLocator('iframe[title="Tour shortlist, route and packet"]');
      const panel = editor.getByRole("region", { name: "Saved space searches" });
      const open = panel.locator(`[data-search-id="${options.searchId}"]`);
      await open.waitFor();
      await open.click();
      await page.reload();
      await open.waitFor();
      await open.click();
      const frame = page.frames().find((frame) => frame.url().includes("/tours/route-editor.html"));
      if (!frame) throw Object.assign(Error("Deal Tour workspace unavailable"), { exitCode: 78 });
      const raw: unknown = await frame.evaluate(
        async ({ dealId, searchId }) => {
          const modulePath = "/js/mcp-requests.mjs";
          const { createMcpRequests } = await import(modulePath);
          const result = await createMcpRequests()(
            "read-deal-space-searches-v1",
            { deal_id: dealId, search_id: searchId },
            { timeoutMs: 10000 },
          );
          if (result.kind !== "payload" || result.isError) throw Error("Independent saved search read unavailable");
          return result.payload;
        },
        { dealId: options.dealId, searchId: options.searchId },
      );
      const expected = parseSearchResponse(raw, options.dealId, true).find((row) => row.id === options.searchId);
      if (!expected) throw Object.assign(Error("Saved search unavailable"), { exitCode: 78 });
      for (const width of [1440, 390])
        for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: 900 });
          await frame.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          const criteria = await panel.locator("form").evaluate((form) => {
            const inputs = Array.from(form.querySelectorAll("input"));
            const selects = Array.from(form.querySelectorAll("select"));
            const nullable = (value: string | undefined) => (value ? Number(value) : null);
            const boolean = (value: string | undefined) => (value === "" ? null : value === "true");
            return {
              query: inputs[1]?.value || null,
              counties: Array.from(selects[0]?.selectedOptions || [], (option) => option.value),
              property_types: (inputs[2]?.value || "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
              min_square_feet: nullable(inputs[3]?.value),
              max_square_feet: nullable(inputs[4]?.value),
              availability: Array.from(selects[1]?.selectedOptions || [], (option) => option.value),
              sort: selects[2]?.value,
              entrance_verified: boolean(selects[3]?.value),
              photos_available: boolean(selects[4]?.value),
              public_projection_ready: boolean(selects[5]?.value),
              cursor: null,
              limit: Number(inputs[5]?.value),
            };
          });
          compareSearch(expected, {
            name: await panel.getByLabel("Search name", { exact: true }).inputValue(),
            requirements: await panel.getByLabel("Budget, timing and other requirements").inputValue(),
            criteria,
            ids: await panel
              .locator("[data-result-property-id]")
              .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-result-property-id") || "")),
          });
          assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
      await panel.getByRole("button", { name: "Cancel search", exact: true }).click();
      return {
        scope:
          "read-only reopened saved search after reload; same criteria and property IDs; cancelled without cart handoff",
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
      "search-id": { type: "string" },
      "fixture-case": { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const result = await proveSearch({
    origin: values.origin,
    expectedCommit: values["expected-commit"] || "",
    cdpUrl: values["cdp-url"],
    dealId: values["deal-id"],
    searchId: values["search-id"],
    fixtureCase: values["fixture-case"],
    timeoutMs: Number(values["timeout-ms"] || 30000),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
