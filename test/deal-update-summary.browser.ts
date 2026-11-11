import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { parseDealUpdateSummary } from "../src/ui/deal-update-summary-model.ts";
import { chromium } from "./browser-harness.mjs";

const recording = JSON.parse(
  await readFile(new URL("../contracts/deal-update-summary.v1/fixture.json", import.meta.url), "utf8"),
);
test("Overview uses one source summary, exact pages, retained originals, retry, stale refresh and focus in four viewports", {
  timeout: 180000,
}, async (t) => {
  const server = await (await createQaServer()).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("/tmp/WR433.S6.J5-shots", { recursive: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.on("pageerror", (e) => console.error(e));
      await page.addInitScript(
        (theme) =>
          localStorage.setItem(
            "doctorcre.visual-preferences",
            JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } }),
          ),
        theme,
      );
      let fail = false,
        stale = false,
        revision = "revision-a",
        calls = 0;
      await page.route("**/mcp", async (route) => {
        const request = route.request().postDataJSON();
        if (request?.params?.name !== "read-deal-update-summary-v1") return route.continue();
        calls++;
        const args = request.params.arguments;
        if (fail) return route.fulfill({ status: 503, body: "Unavailable" });
        if (stale && args.cursor)
          return route.fulfill({
            json: {
              result: {
                isError: true,
                content: [
                  { type: "text", text: JSON.stringify({ error: "stale_history_cursor", refresh_required: true }) },
                ],
              },
            },
          });
        const value = { ...structuredClone(recording), deal_id: args.deal_id, source_revision: revision };
        value.history.revision = revision;
        if (args.cursor) {
          value.history.entries = value.history.entries.slice(2);
          value.history.next_cursor = null;
        } else {
          value.history.entries = value.history.entries.slice(0, 2);
          value.history.next_cursor = "recorded-page-boundary";
        }
        value.history.entries = value.history.entries.map((e: { source: string; original: Record<string, unknown> }) =>
          e.source === "activity"
            ? { ...e, original: { ...e.original, detail: "Synthetic retained long original. ".repeat(50) } }
            : e,
        );
        parseDealUpdateSummary(value, args.deal_id);
        await route.fulfill({ json: { result: { content: [{ type: "text", text: JSON.stringify(value) }] } } });
      });
      await page.request.post(`${server.origin}/api/test/seed`, {
        data: { namespace: `summary-${width}-${theme}`, reset: true },
      });
      await page.goto(`${server.origin}/deals?deal=d14`);
      const root = page.locator("#panelUpdateSummary");
      await root.locator("[data-summary]").filter({ hasText: recording.summary.text }).waitFor();
      await root.screenshot({ path: `/tmp/WR433.S6.J5-shots/${width}-${theme}-summary.png` });
      assert.equal(await root.locator("summary").count(), 1);
      assert.match((await root.locator("[data-coverage]").textContent()) ?? "", /Partial summary/);
      assert.equal(calls, 1);
      const control = root.locator(".updates-history > summary");
      await control.focus();
      await page.keyboard.press("Enter");
      await root.locator(".deal-note").first().waitFor();
      assert.deepEqual(
        await root.locator(".deal-note").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-id"))),
        recording.history.entries.slice(0, 2).map((e: { source: string; id: string }) => `${e.source}:${e.id}`),
      );
      fail = true;
      await root.locator("[data-older]").click();
      await root.getByRole("button", { name: "Retry history" }).waitFor();
      assert.equal(await root.locator(".deal-note").count(), 2);
      fail = false;
      await root.getByRole("button", { name: "Retry history" }).click();
      await root.getByText("End of supported update history.", { exact: true }).waitFor();
      assert.equal(await root.locator(".deal-note").count(), 3);
      const original = root.getByText("Read full update", { exact: true });
      await original.click();
      assert.equal(
        (await root.locator(".note-original").textContent()) ?? "",
        "Landlord offered $24.\n\n" + "Synthetic retained long original. ".repeat(50),
      );
      assert.deepEqual(
        await root.locator(".deal-note > p").allTextContents(),
        recording.history.entries.map((e: { text: string }) => e.text),
      );
      assert.equal(await root.locator("[data-attribution-id]").count(), 1);
      await page.screenshot({ path: `/tmp/WR433.S6.J5-shots/${width}-${theme}.png`, fullPage: true });
      await root.screenshot({ path: `/tmp/WR433.S6.J5-shots/${width}-${theme}-history.png` });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false);
      await original.focus();
      const unchangedRead = page.waitForResponse(
        (response) =>
          response.url().endsWith("/mcp") &&
          response.request().postDataJSON()?.params?.name === "read-deal-update-summary-v1",
      );
      await page.evaluate(() => dispatchEvent(new Event("online")));
      await unchangedRead;
      await root.getByText("End of supported update history.", { exact: true }).waitFor();
      assert.equal(await root.locator(".deal-note").count(), 3);
      assert.equal(await original.evaluate((n) => n === document.activeElement), true);
      assert.equal(await root.locator(".deal-note details").evaluate((n: HTMLDetailsElement) => n.open), true);
      revision = "revision-b";
      await page.locator('[aria-label="Refresh deal"]').click();
      await page.waitForFunction(
        () => document.querySelector("#panelUpdateSummary")?.getAttribute("data-source-revision") === "revision-b",
      );
      await root.getByRole("button", { name: "Load older updates" }).waitFor();
      assert.equal(await root.locator(".updates-history").evaluate((n: HTMLDetailsElement) => n.open), true);
      stale = true;
      revision = "revision-c";
      await root.getByRole("button", { name: "Load older updates" }).click();
      await page.waitForFunction(
        () => document.querySelector("#panelUpdateSummary")?.getAttribute("data-source-revision") === "revision-c",
      );
      assert.equal(await root.locator(".deal-note").count(), 2);
      await control.focus();
      await page.keyboard.press("Enter");
      assert.equal(await control.evaluate((n) => n === document.activeElement), true);
      await page.keyboard.press("Enter");
      assert.equal(await root.locator(".deal-note").count(), 2);
      await page.getByRole("button", { name: "Back to deals" }).click();
      await page.locator("#main").waitFor({ state: "visible" });
      await page.close();
    }
});
