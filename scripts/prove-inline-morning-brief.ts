import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Page } from "playwright";
import { prove as runProof } from "./prove-activity-attribution-panel.mjs";

export async function observeInlineBrief(page: Page, origin: string) {
  await page.goto(`${origin}/?mode=live`);
  const brief = page.locator("#homeBrief #docMorningBrief");
  await brief.waitFor();
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      const previous = await page.locator("#morningUpdated").getAttribute("datetime");
      const started = Date.now();
      const reading = page.waitForResponse((response) => {
        if (new URL(response.url()).pathname !== "/mcp") return false;
        try {
          return response.request().postDataJSON().params?.name === "morning-brief";
        } catch {
          return false;
        }
      });
      await page.locator("#morningRefresh").click();
      const raw: unknown = await (await reading).json();
      await page.waitForFunction(
        (previous) => document.getElementById("morningUpdated")?.getAttribute("datetime") !== previous,
        previous,
      );
      const { normalizeBrief, morningBriefView } = await import(
        new URL("../js/morning-brief-model.js", import.meta.url).href
      );
      const { createMcpRequests } = await import(new URL("../js/mcp-requests.mjs", import.meta.url).href);
      const request = createMcpRequests({
        fetchImpl: async () => new Response(JSON.stringify(raw), { headers: { "content-type": "application/json" } }),
      });
      const result = await request("morning-brief", {});
      if (result.kind !== "payload" || result.isError) throw Error("Invalid independent RPC envelope");
      const payload = normalizeBrief(result.payload);
      if (!payload) throw Error("Invalid independent morning-brief response");
      const scope = await page.evaluate(() => ({
        owner: document.querySelector<HTMLElement>('#morningOwners [aria-pressed="true"]')?.dataset.briefOwner || "all",
        observed: document.getElementById("morningUpdated")?.getAttribute("datetime") || "",
      }));
      const view = morningBriefView(payload, {
        now: new Date(scope.observed),
        events: [],
        caughtUp: false,
        owner: scope.owner,
      });
      const expected = {
        title: `Morning brief · ${payload.sponsor === "joe" ? "Joe" : "Dell"}`,
        observed: view.observedAt,
        cards: view.groups.map(({ row }: { row: { key: string; title: string; due: string | null } }) => ({
          key: row.key,
          title: row.title,
          due: row.due,
        })),
        sections: view.coverage.map((row: { key: string }) => row.key),
      };
      assert.ok(
        Date.parse(expected.observed) >= started && Date.parse(expected.observed) <= Date.now(),
        "Observed clock belongs to this read",
      );
      assert.equal(await page.locator("dialog#docMorningBrief").count(), 0);
      assert.equal(await page.locator("#morningTitle").textContent(), expected.title);
      for (const card of expected.cards) {
        const node = brief.locator(`[data-brief-key="${card.key}"]`);
        assert.equal(await node.count(), 1, "Independent priority remains visible");
        assert.equal(await node.locator("strong").textContent(), card.title);
        if (card.due) assert.equal(await node.locator("time").getAttribute("datetime"), card.due);
        else assert.equal(await node.locator("time").count(), 0);
      }
      assert.deepEqual(
        await brief
          .locator("[data-brief-section]")
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-brief-section"))),
        expected.sections,
      );
      const first = brief.locator("[data-brief-record]").first();
      if (!(await first.count())) throw Object.assign(Error("Populated priority required"), { exitCode: 78 });
      const key = await first.getAttribute("data-brief-key");
      await first.click();
      await brief.locator(".morning-record").waitFor();
      await page.locator("#morningBack").click();
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-brief-key")), key);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  return { scope: "source-bound inline priorities, coverage and return focus at 1440 and 390 in both themes" };
}
export const proveInlineBrief = (options: {
  origin: string;
  expectedCommit: string;
  cdpUrl?: string | undefined;
  timeoutMs?: number;
}) => runProof({ ...options, observe: observeInlineBrief });
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      origin: { type: "string", default: "https://app.doctorcre.com" },
      "expected-commit": { type: "string" },
      "cdp-url": { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const result = await proveInlineBrief({
    origin: values.origin,
    expectedCommit: values["expected-commit"] || "",
    cdpUrl: values["cdp-url"],
    timeoutMs: Number(values["timeout-ms"] || 30000),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
