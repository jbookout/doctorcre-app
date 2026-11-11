import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Page } from "playwright";
import type { createLiveClient as ClientFactory } from "../js/live-client.d.ts";
import type { normalizeBrief as ParseBrief, morningBriefView as ViewBrief } from "../js/morning-brief-model.d.ts";
import { prove as runProof } from "./prove-activity-attribution-panel.mjs";

export async function observeInlineBrief(page: Page, origin: string) {
  await page.goto(`${origin}/?mode=live`);
  const brief = page.locator("#homeBrief #docMorningBrief");
  const toggle = page.locator(".home-brief-toggle");
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
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
      const expected = await page
        .evaluate(async (raw) => {
          const { normalizeBrief, morningBriefView } = await import("/js/morning-brief-model.js");
          const { createLiveClient } = await import("/js/live-client.js");
          const snapshot = createLiveClient({
            fetchImpl: async () =>
              new Response(JSON.stringify(raw), { headers: { "content-type": "application/json" } }),
          });
          const payload: ReturnType<typeof ParseBrief> = normalizeBrief(await snapshot.morningBrief({ fresh: true }));
          if (!payload) throw Error("Invalid independent morning-brief response");
          const owner =
            document.querySelector<HTMLElement>('#morningOwners [aria-pressed="true"]')?.dataset.briefOwner || "all";
          const observed = document.getElementById("morningUpdated")?.getAttribute("datetime") || "";
          const preference = JSON.parse(localStorage.getItem(`doctorcre:morning:${payload.sponsor}`) || "{}");
          const since = typeof preference.since === "string" ? preference.since : "";
          if (!Number.isFinite(Date.parse(since))) throw Error("Brief cutoff unavailable");
          const client: ReturnType<typeof ClientFactory> = createLiveClient();
          const events: unknown[] = [];
          let cursor: string | null = null,
            caughtUp = false;
          for (let page = 0; page < 4; page++) {
            const changes = await client.getChanges(cursor, { since });
            if (!Array.isArray(changes.events)) throw Error("Invalid changes response");
            events.push(...changes.events);
            cursor = changes.cursor;
            if (!changes.events.length) {
              caughtUp = true;
              break;
            }
          }
          if (!caughtUp) throw Error("Overnight source window incomplete");
          const view: ReturnType<typeof ViewBrief> = morningBriefView(payload, {
            now: new Date(observed),
            since,
            events,
            caughtUp,
            owner,
          });
          if (!view) throw Error("Invalid independent brief view");
          return {
            title: `Morning brief · ${payload.sponsor === "joe" ? "Joe" : "Dell"}`,
            observed: view.observedAt,
            cards: view.groups.map(({ row }) => ({ key: row.key, title: row.title, due: row.due })),
            sections: view.coverage.map((row) => row.key),
          };
        }, raw)
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            /Brief cutoff unavailable|Overnight source window incomplete/.test(error.message)
          )
            throw Object.assign(error, { exitCode: 78 });
          throw error;
        });
      assert.ok(
        Date.parse(expected.observed) >= started && Date.parse(expected.observed) <= Date.now(),
        "Observed clock belongs to this read",
      );
      assert.equal(await page.locator("dialog#docMorningBrief").count(), 0);
      assert.equal(await page.locator("#morningTitle").textContent(), expected.title);
      assert.equal(await brief.locator("[data-brief-record]").count(), expected.cards.length);
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
