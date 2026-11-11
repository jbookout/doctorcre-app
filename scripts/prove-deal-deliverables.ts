import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Page } from "playwright";
import { parseDeliverable, parseDeliverableList } from "../src/ui/deal-deliverable-contract.ts";
import { prove } from "./prove-activity-attribution-panel.mjs";

const unavailable = (message: string) => Object.assign(Error(message), { exitCode: 78 });
export async function proveDeliverables({
  origin,
  expectedCommit,
  cdpUrl,
  dealId,
  expected,
  fixtureCase,
}: {
  origin: string;
  expectedCommit: string;
  cdpUrl?: string;
  dealId: string;
  expected: unknown;
  fixtureCase?: string;
}) {
  const receipt = parseDeliverable(expected, dealId);
  if (fixtureCase) {
    if (!["pass", "fail", "insufficient"].includes(fixtureCase)) throw unavailable("Unknown fixture case");
    return prove({
      origin,
      expectedCommit,
      readRelease: async () => ({ source_commit: fixtureCase === "insufficient" ? "0".repeat(40) : expectedCommit }),
      contains: async (a: string, b: string) => {
        if (a !== b) throw unavailable("Containing release unavailable");
      },
      engine: { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) },
      observe: async () => {
        const list = parseDeliverableList(
          { ok: true, schema_version: "deal-deliverables.v1", deliverables: fixtureCase === "fail" ? [] : [receipt] },
          dealId,
        );
        assert.deepEqual(
          list.find((row) => row.id === receipt.id),
          receipt,
        );
        return { scope: "contract fixture" };
      },
    });
  }
  return prove({
    origin,
    expectedCommit,
    cdpUrl,
    observe: async (page: Page) => {
      if (!cdpUrl) throw unavailable("Existing signed-in browser required");
      const observations = [];
      for (const width of [1440, 390])
        for (const theme of ["light", "dark"] as const) {
          await page.setViewportSize({ width, height: 1000 });
          await page.emulateMedia({ colorScheme: theme });
          await page.goto(`${origin}/deals?deal=${dealId}`);
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await page.getByRole("tab", { name: "Documents", exact: true }).click();
          const panel = page.getByRole("region", { name: "Deal Deliverables", exact: true });
          await panel.getByRole("link", { name: `Download ${receipt.filename}`, exact: true }).waitFor();
          const item = panel
            .locator("li")
            .filter({ has: page.getByRole("heading", { name: receipt.filename, exact: true }) });
          assert.equal(await item.locator("h3").textContent(), receipt.filename);
          assert.equal(
            await item.locator(":scope > p").textContent(),
            `${receipt.bytes.toLocaleString()} bytes · ${receipt.visibility === "private" ? "Private" : "Shared · ready for publication"} · Version ${receipt.version}`,
          );
          assert.deepEqual(await item.locator("details p").allTextContents(), [
            `SHA-256 ${receipt.sha256}`,
            receipt.id,
          ]);

          const chooserPromise = page.waitForEvent("filechooser");
          await panel.getByRole("button", { name: "Drop a deliverable or choose a file" }).click();
          const chooser = await chooserPromise;
          await chooser.setFiles([]);
          const value: unknown = await page.evaluate(async (deal) => {
            const sessionPath = "/js/private-session.js";
            const { sessionFetch } = await import(sessionPath);
            const response = await sessionFetch(`/api/v1/deal-deliverables/${deal}`, {
              credentials: "same-origin",
              cache: "no-store",
            });
            if (!response.ok) return null;
            return response.json();
          }, dealId);
          const rows = parseDeliverableList(value, dealId);
          assert.deepEqual(
            rows.find((row) => row.id === receipt.id),
            receipt,
          );
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          observations.push({ width, theme, receipt });
        }
      return {
        observations,
        scope: "read-only chooser and existing canonical receipt; no new upload or client publication claimed",
      };
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        origin: { type: "string", default: "https://app.doctorcre.com" },
        "expected-commit": { type: "string" },
        "cdp-url": { type: "string" },
        "deal-id": { type: "string" },
        "expected-json": { type: "string" },
        "fixture-case": { type: "string" },
      },
    });
    const expected = values["expected-json"] ? JSON.parse(await readFile(values["expected-json"], "utf8")) : null;
    const result = await proveDeliverables({
      origin: values.origin,
      expectedCommit: values["expected-commit"] ?? "",
      dealId: values["deal-id"] ?? "",
      expected,
      ...(values["cdp-url"] ? { cdpUrl: values["cdp-url"] } : {}),
      ...(values["fixture-case"] ? { fixtureCase: values["fixture-case"] } : {}),
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "insufficient_evidence",
        error: error instanceof Error ? error.message : "Proof unavailable",
      }),
    );
    process.exitCode = 78;
  }
}
