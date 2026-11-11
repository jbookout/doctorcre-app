import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseSearchResponse } from "../src/ui/deal-space-search-model.ts";
import { prove as runProof } from "./prove-activity-attribution-panel.mjs";

export async function provePrefill(options: {
  fixture?: boolean;
  origin: string;
  expectedCommit: string;
  cdpUrl?: string | undefined;
  dealId?: string | undefined;
  searchId?: string | undefined;
  timeoutMs?: number;
}) {
  return runProof({
    ...options,
    observe: async (page, origin) => {
      if (
        (!options.cdpUrl && !(options.fixture && ["localhost", "127.0.0.1"].includes(new URL(origin).hostname))) ||
        !options.dealId ||
        !/^[a-f0-9-]{36}$/i.test(options.dealId)
      )
        throw Object.assign(Error("Signed-in CDP session and deal ID required"), { exitCode: 78 });
      await page.goto(`${origin}/deals?deal=${options.dealId}&tab=tours&tour=new`);
      const editor = page.frameLocator('iframe[title="Tour shortlist, route and packet"]');
      const panel = editor.getByRole("region", { name: "Saved space searches" });
      await panel.getByRole("button", { name: "New space search", exact: true }).waitFor();
      const frame = page.frames().find((f) => f.url().includes("/tours/route-editor.html"));
      if (!frame) throw Object.assign(Error("Deal workspace unavailable"), { exitCode: 78 });
      const expected = await frame.evaluate(async (dealId) => {
        const path = "/js/mcp-requests.mjs";
        const { createMcpRequests } = await import(path);
        const result = await createMcpRequests()("get-deal-room", { deal: dealId }, { timeoutMs: 10000 });
        if (result.kind !== "payload" || result.isError || result.payload.deal_id !== dealId)
          throw Error("Deal unavailable");
        const clientPath = "/tours/planner-client.js";
        const { createPlannerClient } = await import(clientPath);
        return createPlannerClient().client(result.payload.client_id);
      }, options.dealId);
      for (const width of [1440, 390])
        for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: 900 });
          await frame.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await panel.getByRole("button", { name: "New space search", exact: true }).click();
          await panel.getByRole("button", { name: "Review or refresh client context", exact: true }).click();
          const review = panel.getByRole("region", { name: "Client context review" });
          await review.getByText(`Client ${expected.id}`, { exact: true }).waitFor();
          const fields = review.locator("fieldset");
          assert.equal(
            await fields.nth(0).locator("p").nth(1).textContent(),
            `Client source · ${expected.name} space search`,
          );
          assert.equal(
            await fields.nth(1).locator("p").nth(1).textContent(),
            `Client source · ${expected.notes || "Empty"}`,
          );
          assert.equal(
            await review.getByText(/^Location context · /).textContent(),
            `Location context · ${[expected.city, expected.state].filter(Boolean).join(", ") || "Unknown"}. This is not a search preference.`,
          );
          assert.equal(
            await review.getByText(/^Use context · /).textContent(),
            `Use context · ${expected.vertical || expected.specialty || "Unknown"}. Size and budget remain unspecified.`,
          );
          const observed = await review.locator("time").getAttribute("datetime");
          assert.ok(observed && Number.isFinite(Date.parse(observed)));
          assert.equal(await review.locator("a").getAttribute("href"), `/api/v1/business/clients/${expected.id}`);
          await panel.getByLabel("Search name", { exact: true }).fill("Read-only proof draft");
          await panel.getByLabel("Budget, timing and other requirements").fill("");
          await panel.getByRole("button", { name: "Review or refresh client context", exact: true }).click();
          await review.getByText(`Client ${expected.id}`, { exact: true }).waitFor();
          await review.getByLabel("Keep my name", { exact: true }).check();
          await review.getByLabel("Keep my requirements", { exact: true }).check();
          await review.getByRole("button", { name: "Apply reviewed choices", exact: true }).click();
          await review.getByText("Reviewed choices applied to this draft.", { exact: true }).waitFor();
          assert.equal(await panel.getByLabel("Search name", { exact: true }).inputValue(), "Read-only proof draft");
          assert.equal(await panel.getByLabel("Budget, timing and other requirements").inputValue(), "");
          assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await panel.getByRole("button", { name: "Cancel search", exact: true }).click();
        }
      if (!options.searchId)
        throw Object.assign(
          Error("Cancelled drafts passed. Existing sourced saved-search ID required for persisted-prefill proof."),
          { exitCode: 78 },
        );
      const raw = await frame.evaluate(
        async ({ dealId, searchId }) => {
          const path = "/js/mcp-requests.mjs";
          const { createMcpRequests } = await import(path);
          const result = await createMcpRequests()(
            "read-deal-space-searches-v1",
            { deal_id: dealId, search_id: searchId },
            { timeoutMs: 10000 },
          );
          if (result.kind !== "payload" || result.isError) throw Error("Saved source unavailable");
          return result.payload;
        },
        { dealId: options.dealId, searchId: options.searchId },
      );
      const saved = parseSearchResponse(raw, options.dealId, true).find((row) => row.id === options.searchId);
      if (!saved?.client_prefill_source)
        throw Object.assign(Error("Existing authorized sourced receipt required"), { exitCode: 78 });
      assert.equal(saved.client_prefill_source.client_id, expected.id);
      await panel.locator(`[data-search-id="${saved.id}"]`).click();
      assert.equal(await panel.getByLabel("Search name", { exact: true }).inputValue(), saved.name);
      assert.equal(await panel.getByLabel("Budget, timing and other requirements").inputValue(), saved.requirements);
      assert.equal(
        await panel
          .getByText(
            `Client prefill source · ${saved.client_prefill_source.source_ref} · client ${expected.id} · observed ${saved.client_prefill_source.observed_at}`,
            { exact: true },
          )
          .count(),
        1,
      );
      await panel.getByRole("button", { name: "Cancel search", exact: true }).click();
      return { scope: "cancelled drafts and existing persisted source identity; no production writes" };
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      fixture: { type: "boolean" },
      origin: { type: "string", default: "https://app.doctorcre.com" },
      "expected-commit": { type: "string" },
      "cdp-url": { type: "string" },
      "deal-id": { type: "string" },
      "search-id": { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const result = await provePrefill({
    fixture: values.fixture ?? false,
    origin: values.origin,
    expectedCommit: values["expected-commit"] || "",
    cdpUrl: values["cdp-url"],
    dealId: values["deal-id"],
    searchId: values["search-id"],
    timeoutMs: Number(values["timeout-ms"] || 30000),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
