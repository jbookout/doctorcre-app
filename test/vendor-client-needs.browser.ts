import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium, pausedClock } from "./browser-harness.mjs";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const recorded = JSON.parse(await readFile(new URL("./fixtures/client-needs/recorded.json", import.meta.url), "utf8"));
test("selected vendor reads exact needs, refreshes, pages and retires in both themes and widths", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("/tmp/WR591.S27.J4-shots", { recursive: true });
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        let mode = "approved";
        let release: (() => void) | undefined;
        const requests: { vendor: string; offset: number; limit: number }[] = [];
        await page.route("https://**", (route) => route.abort());
        await page.route("**/api/v1/business/**", (route) => {
          const url = route.request().url().replace(recorded.subject_id, "00000000-0000-4000-8000-000000000001");
          const body = directoryFixture(url);
          if (body.record) Reflect.set(body.record, "id", recorded.subject_id);
          return route.fulfill({ json: body });
        });
        await page.route("**/mcp", async (route) => {
          const req = route.request().postDataJSON();
          let payload: unknown = {};
          if (req.params.name === "read-vendor-client-needs-v1") {
            requests.push(req.params.arguments);
            if (mode === "hold")
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            if (mode === "refused") return route.fulfill({ status: 403 });
            if (mode === "error") return route.fulfill({ status: 503 });
            payload =
              mode === "missing"
                ? { ...recorded, state: "missing_approval", rows: [] }
                : ["withdrawn", "stale", "empty"].includes(mode)
                  ? { ...recorded, state: "empty", rows: [] }
                  : { ...recorded, next_offset: mode === "pages" ? 5 : null };
          }
          await route
            .fulfill({
              json: {
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
              },
            })
            .catch(() => {});
        });
        await page.goto(`${server.origin}/vendors?record=${recorded.subject_id}`);
        await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), theme);
        const section = page.getByRole("region", { name: "Approved client needs", exact: true });
        await section.getByText(recorded.rows[0].description, { exact: true }).waitFor();
        const row = section.locator("[data-need-id]");
        assert.equal(await row.count(), 1);
        assert.equal(await row.getAttribute("data-need-id"), recorded.rows[0].id);
        for (const value of [
          recorded.rows[0].client_name,
          recorded.rows[0].deal_name,
          recorded.rows[0].source_ref,
          recorded.rows[0].source_revision,
          recorded.rows[0].applicability,
          "Approved · revision 1",
        ]) {
          assert.equal(await row.getByText(value, { exact: true }).count(), 1);
        }
        await section.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/WR591.S27.J4-shots/${width}-${theme}.png` });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(requests[0], { vendor: recorded.subject_id, offset: 0, limit: 5 });
        const refresh = () => section.getByRole("button", { name: "Refresh client needs", exact: true }).click();
        const retry = () => section.getByRole("button", { name: "Retry client needs", exact: true }).click();
        mode = "hold";
        await refresh();
        await section.getByText("Reading client needs…", { exact: true }).waitFor();
        assert.equal(await row.count(), 0);
        mode = "approved";
        release?.();
        await section.getByText(recorded.rows[0].description, { exact: true }).waitFor();
        for (const next of ["withdrawn", "stale", "empty", "missing", "refused", "error", "pages"]) {
          mode = next;
          if (await section.getByRole("button", { name: "Retry client needs", exact: true }).count()) await retry();
          else await refresh();
          const expected =
            next === "missing"
              ? "Approval needed. No approved client needs can be shown."
              : next === "refused"
                ? "Permission refused. Client needs are not available to this session."
                : next === "error"
                  ? "Client needs unavailable. The source could not be verified."
                  : next === "pages"
                    ? recorded.rows[0].description
                    : "No approved client needs match this vendor.";
          await section.getByText(expected, { exact: true }).waitFor();
          assert.equal(await row.count(), next === "pages" ? 1 : 0);
        }
        mode = "approved";
        await section.getByRole("button", { name: "Next needs", exact: true }).click();
        await section.getByText(recorded.rows[0].description, { exact: true }).waitFor();
        assert.equal(requests.at(-1)?.offset, 5);
        assert.equal(new URL(page.url()).searchParams.get("record"), recorded.subject_id);
        await page.reload();
        await section.getByText(recorded.rows[0].description, { exact: true }).waitFor();
        await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
        assert.equal(await row.count(), 0);
        for (const retiring of ["hold", "missing", "empty", "error", "refused"]) {
          mode = retiring;
          const started = page.waitForRequest(
            (request) =>
              request.url().endsWith("/mcp") && request.postDataJSON()?.params?.name === "read-vendor-client-needs-v1",
          );
          await page.reload();
          await started;
          const copy =
            retiring === "hold"
              ? "Reading client needs…"
              : retiring === "missing"
                ? "Approval needed. No approved client needs can be shown."
                : retiring === "empty"
                  ? "No approved client needs match this vendor."
                  : retiring === "refused"
                    ? "Permission refused. Client needs are not available to this session."
                    : "Client needs unavailable. The source could not be verified.";
          await section.getByText(copy, { exact: true }).waitFor();
          await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
          release?.();
          assert.equal(await section.count(), 0, `retired from ${retiring}`);
        }
      } finally {
        await page.close();
      }
    }
});

test("approved needs expire at the earliest deadline and on panel resume without refresh", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "production", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"])
      for (const resume of [false, true]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          const now = Date.parse(recorded.as_of);
          await pausedClock(page, now);
          const response = structuredClone(recorded);
          response.rows[0].fresh_until = new Date(now + 60_000).toISOString();
          response.rows.push({
            ...response.rows[0],
            id: "00000000-0000-4000-8000-000000000099",
            fresh_until: new Date(now + 120_000).toISOString(),
          });
          let reads = 0;
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("https://**", (route) => route.abort());
          await page.route("**/mcp", (route) => {
            const req = route.request().postDataJSON();
            const needs = req.params.name === "read-vendor-client-needs-v1";
            if (needs) reads++;
            return route.fulfill({
              json: {
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ type: "text", text: JSON.stringify(needs ? response : {}) }] },
              },
            });
          });
          await page.route("**/js/needs-clock-probe.js", (route) =>
            route.fulfill({
              contentType: "application/javascript",
              body: `import { mountVendorClientNeeds } from '/js/ui-vendor-client-needs.js';
              import { mountLocalTicker } from '/js/visibility-poll.mjs';
              import { createMcpRequests } from '/js/mcp-requests.mjs';
              const request = createMcpRequests({ fetchImpl: fetch });
              mountVendorClientNeeds(document.querySelector('main'), ${JSON.stringify(recorded.subject_id)},
                async (query, signal) => (await request('read-vendor-client-needs-v1', query, { signal })).payload,
                mountLocalTicker);`,
            }),
          );
          await page.route("**/vendors?*", async (route) => {
            const response = await route.fetch();
            await route.fulfill({
              response,
              body: '<!doctype html><html><head><script type="module" src="/js/needs-clock-probe.js"></script></head><body><main></main></body></html>',
            });
          });
          const navigation = await page.goto(`${server.origin}/vendors?record=${recorded.subject_id}`);
          assert.match(navigation?.headers()["content-security-policy"] || "", /script-src 'self'/);
          await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), theme);
          const section = page.getByRole("region", { name: "Approved client needs", exact: true });
          const rows = section.locator("[data-need-id]");
          await rows.nth(1).waitFor();
          await page.waitForLoadState("networkidle");
          if (resume) {
            await page.evaluate(() => {
              Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
              document.dispatchEvent(new Event("visibilitychange"));
            });
            await page.clock.fastForward(30_000);
            await page.evaluate(() => {
              Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
              document.dispatchEvent(new Event("visibilitychange"));
            });
          }
          await page.waitForLoadState("networkidle");
          await page.clock.fastForward(resume ? 29_999 : 59_999);
          assert.equal(await rows.count(), 2, "both rows remain fresh before the first deadline");
          await page.clock.fastForward(1);
          await section
            .locator(`[data-need-id="${response.rows[0].id}"]`)
            .waitFor({ state: "detached", timeout: 2000 });
          assert.equal(await rows.first().getAttribute("data-need-id"), response.rows[1].id);
          if (resume) {
            await page.evaluate(() => {
              Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
              document.dispatchEvent(new Event("visibilitychange"));
            });
            await page.clock.fastForward(120_000);
            await page.evaluate(() => {
              Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
              document.dispatchEvent(new Event("visibilitychange"));
            });
          } else await page.clock.fastForward(60_000);
          await section.getByText("No approved client needs match this vendor.", { exact: true }).waitFor();
          assert.equal(await rows.count(), 0);
          assert.equal(reads, 1, "local expiry performs no network revalidation");
          assert.deepEqual(errors, []);
          if (!resume) {
            await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
            assert.equal(await section.count(), 0, "session retirement clears the locally expired panel");
            continue;
          }
          await section.getByRole("button", { name: "Refresh client needs", exact: true }).click();
          await section.getByRole("alert").waitFor();
          assert.equal(await rows.count(), 0, "revalidating an expired producer response cannot restore rows");
          const renewedUntil = new Date((await page.evaluate(() => Date.now())) + 60_000).toISOString();
          for (const row of response.rows) row.fresh_until = renewedUntil;
          await section.getByRole("button", { name: "Retry client needs", exact: true }).click();
          await rows.nth(1).waitFor();
          assert.equal(await rows.count(), 2, "a freshly approved response can restore needs after revalidation");
        } finally {
          await page.close();
        }
      }
});
