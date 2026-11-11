import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { generatedSheet, sheetHistory } from "../src/ui/broker-cheat-sheet.ts";
import { prove as runProof } from "./prove-activity-attribution-panel.mjs";

export async function proveSheet(options: {
  origin: string;
  expectedCommit: string;
  cdpUrl?: string | undefined;
  fixtureCase?: string | undefined;
  timeoutMs?: number;
}) {
  const check = (notes: string, rendered: string, history: unknown) => {
    assert.equal(rendered, notes, "Editor matches the saved broker notes exactly");
    assert.ok(sheetHistory(history).length, "Saved revision history is readable");
  };
  if (options.fixtureCase) {
    return runProof({
      origin: options.origin,
      expectedCommit: options.expectedCommit,
      readRelease: async () => ({ source_commit: options.expectedCommit }),
      contains: async () => {},
      engine: { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) },
      observe: async () => {
        check("Broker preparation", options.fixtureCase === "pass" ? "Broker preparation" : "Changed notes", {
          revisions: [
            {
              revision_id: "11111111-1111-4111-8111-111111111111",
              revision_number: 1,
              content: { notes: "Broker preparation" },
            },
          ],
        });
        return { scope: "synthetic contract fixture" };
      },
    });
  }
  return runProof({
    ...options,
    observe: async (page, origin) => {
      await page.goto(`${origin}/tours/route-editor.html`);
      const first = page.locator(".tour-button").first();
      try {
        await first.waitFor({ state: "visible" });
      } catch {
        throw Object.assign(Error("Authenticated populated tour required"), { exitCode: 78 });
      }
      await first.click();
      await page.locator("#tour-panel").waitFor({ state: "visible" });
      const sheet = page.locator("#internal-cheat-sheet");
      if (!(await sheet.evaluate((node) => node instanceof HTMLDetailsElement && node.open)))
        await sheet.locator(":scope > summary").click();
      const notes = await page.locator("#cheat-content").inputValue();
      const reading = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/tours/cheat-sheet/history/v1",
      );
      await page.getByRole("button", { name: "Read saved revisions" }).click();
      const envelope: unknown = await (await reading).json();
      if (!envelope || typeof envelope !== "object" || !("data" in envelope)) throw Error("Missing history envelope");
      const rows = sheetHistory(envelope.data),
        current = rows[0];
      if (!current || typeof current.content.notes !== "string")
        throw Object.assign(Error("Saved notes required"), { exitCode: 78 });
      check(current.content.notes, notes, envelope.data);
      await page.locator("#sheet-history summary").first().waitFor();
      const latest = page.locator("#sheet-history details").first();
      await latest.locator("summary").click();
      assert.equal(
        await latest.locator("pre").textContent(),
        [generatedSheet(current.content), current.content.notes].filter(Boolean).join("\n\n"),
      );
      for (const width of [1440, 390])
        for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            `${width} ${theme} overflow`,
          );
          assert.equal(await page.locator("#cheat-content").inputValue(), notes);
        }
      return {
        scope: "read-only saved sheet and revisions at both widths and themes; writes proven in local acceptance tests",
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
      "fixture-case": { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const result = await proveSheet({
    origin: values.origin,
    expectedCommit: values["expected-commit"] || "",
    cdpUrl: values["cdp-url"],
    fixtureCase: values["fixture-case"],
    timeoutMs: Number(values["timeout-ms"] || 30000),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
