import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { parseDealUpdateSummary } from "../src/ui/deal-update-summary-model.ts";
import { chromium } from "./browser-harness.mjs";

test("summary history preserves click-only attribution and retires explanations on refresh, close and deal switch", {
  timeout: 120000,
}, async (t) => {
  const summary = JSON.parse(
    await readFile(new URL("../contracts/deal-update-summary.v1/fixture.json", import.meta.url), "utf8"),
  );
  const attribution = JSON.parse(
    await readFile(new URL("./fixtures/activity-attribution-panel/recordings.json", import.meta.url), "utf8"),
  ).cases[0].response;
  const id = attribution.activity.id;
  const server = await (await createQaServer()).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.request.post(`${server.origin}/api/test/seed`, {
    data: { namespace: "summary-attribution", reset: true },
  });
  let calls = 0,
    hold = false,
    release: (() => void) | undefined;
  await page.route("**/mcp", async (route) => {
    const request = route.request().postDataJSON();
    if (request.params.name === "read-deal-update-summary-v1") {
      const value = { ...structuredClone(summary), deal_id: request.params.arguments.deal_id };
      const old = value.history.entries.find((e: { source: string }) => e.source === "activity").id;
      value.history.entries = value.history.entries.map((e: { source: string; original: Record<string, unknown> }) =>
        e.source === "activity" ? { ...e, id, original: { ...e.original, id } } : e,
      );
      value.summary.citations = value.summary.citations.map((e: { source: string }) =>
        e.source === "activity" ? { ...e, id } : e,
      );
      value.summary.text = value.summary.text.replace(`activity:${old}`, `activity:${id}`);
      parseDealUpdateSummary(value, value.deal_id);
      return route.fulfill({ json: { result: { content: [{ type: "text", text: JSON.stringify(value) }] } } });
    }
    if (request.params.name !== "read-activity-deal-attribution") return route.continue();
    assert.deepEqual(request.params.arguments, { activity_id: id });
    calls++;
    if (hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({ json: { result: { content: [{ type: "text", text: JSON.stringify(attribution) }] } } });
  });
  await page.goto(`${server.origin}/deals`);
  const open = async () => {
    await page.locator('.kanban-card[data-id="d14"] .card-open').click();
    await page.locator(".updates-history > summary").click();
    await page.getByRole("button", { name: "Show deal attribution" }).waitFor();
  };
  await open();
  assert.equal(calls, 0);
  await page.getByRole("button", { name: "Show deal attribution" }).click();
  await page.getByRole("heading", { name: "Direct deal attribution" }).waitFor();
  assert.equal(calls, 1);
  await page.getByText("Version evidence", { exact: true }).click();
  await page.locator("[data-refresh-detail]").first().click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Activity deal attribution"]'));
  await page.getByRole("button", { name: "Show deal attribution" }).waitFor();
  await page.getByRole("button", { name: "Back to deals", exact: true }).click();
  await open();
  hold = true;
  await page.getByRole("button", { name: "Show deal attribution" }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Activity deal attribution"]'));
  await page.getByRole("button", { name: "Back to deals", exact: true }).click();
  release?.();
  hold = false;
  await page.locator('.kanban-card:not([data-id="d14"]) .card-open').first().click();
  await page.locator("#detailUpdateForm").waitFor();
  assert.equal(await page.locator('[aria-label="Activity deal attribution"]').count(), 0);
});
