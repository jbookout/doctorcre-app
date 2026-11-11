import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Page } from "playwright";
import { uiBundle } from "../scripts/ui-bundle.mjs";
import type { mountDealTours as MountDealTours } from "../src/ui/deal-tours.tsx";
import { chromium, WAIT_MS } from "./browser-harness.mjs";

test("retired tour workspace refuses UI re-entry after session invalidation", async (t) => {
  const bundle = await uiBundle((path) => readFile(new URL("../" + path, import.meta.url), "utf8"));
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: '<div id="view"></div>' }));
  await page.goto("http://fixture.test/deals");
  const result = await page.evaluate(async (source) => {
    const { mountDealTours } = await import("data:text/javascript;base64," + source);
    let reads = 0,
      navigations = 0;
    const root = document.querySelector("#view");
    if (!root) throw Error("Fixture mount missing");
    const panel = mountDealTours(root, {
      dealId: "11111111-1111-4111-8111-111111111111",
      client: {
        library: async () => {
          ++reads;
          return [];
        },
      },
      navigate() {
        ++navigations;
      },
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    root.querySelector<HTMLButtonElement>("[data-start-tour]")?.click();
    const opened = !!root.querySelector("iframe");
    dispatchEvent(new Event("doctorcre-session-invalidated"));
    const before = { reads, navigations };
    root.querySelector<HTMLButtonElement>("[data-start-tour]")?.click();
    await panel.refresh();
    const result = { opened, frame: !!root.querySelector("iframe"), before, after: { reads, navigations } };
    panel.dispose();
    return result;
  }, bundle.toString("base64"));
  assert.equal(result.opened, true);
  assert.equal(result.frame, false, "Retired workspace must not recreate an iframe");
  assert.deepEqual(result.after, result.before);
});

async function savedEditorReady(page: Page) {
  const deadline = performance.now() + WAIT_MS;
  const remaining = () => Math.max(1, deadline - performance.now());
  await page
    .frameLocator("iframe")
    .locator("#sheet-state")
    .filter({ hasText: /save confirmed/ })
    .waitFor({ timeout: remaining() });
  await page.waitForFunction(() => !window.editorRetirementPanel.hasUnsavedChanges(), undefined, {
    timeout: remaining(),
  });
}

const deal = "11111111-1111-4111-8111-111111111111";
const tour = "33333333-3333-4333-8333-333333333333";
const receipt = "44444444-4444-4444-8444-444444444444";
const routeId = "55555555-5555-4555-8555-555555555555";
const row = {
  id: tour,
  deal_id: deal,
  name: "Synthetic editor retirement",
  status: "draft",
  stops: [],
  routes: [{ id: routeId, route_version: 1, accepted: false, stops: [] }],
  route_version_id: routeId,
  route_version_state: "draft",
  accepted_route_version: 0,
};

test("packet editor retirement transitions in the parent workspace", async (t) => {
  const { buildArtifact } = await import("../scripts/artifact.mjs");
  const { temporaryDirectory } = await import("../scripts/temp-directory.mjs");
  const { ownedServer: startFixtureServer } = await import("./fixture-probe.ts");
  const { fileURLToPath } = await import("node:url");
  const artifact = await temporaryDirectory("doctorcre-editor-retirement-", t);
  await buildArtifact({
    root: fileURLToPath(new URL("../", import.meta.url)),
    outDir: artifact,
    commit: "1".repeat(40),
  });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: `${artifact}/site` } });
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const bundle = await uiBundle((path) => readFile(new URL("../" + path, import.meta.url), "utf8"));
  for (const state of ["Dirty", "Saving success", "Saving failure", "Saved"])
    for (const reason of ["session", "scope"]) {
      await t.test(`${state} to Retired on ${reason}`, async () => {
        const page = await browser.newPage();
        let release!: () => void, finished!: () => void, releaseReadback!: () => void;
        const readbackGate = new Promise<void>((resolve) => {
          releaseReadback = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const responded = new Promise<void>((resolve) => {
          finished = resolve;
        });
        let reads = 0,
          scope = "synthetic-actor-a",
          notes = "",
          revision = 0;
        const writes: { tour_id: string; expected_revision_number: number; idempotency_key: string }[] = [];
        try {
          await page.route(/^https:\/\//, (route) => route.abort());
          await page.route("**/auth/session", (route) =>
            route.fulfill({ json: { actor: { slug: "fixture" }, csrf_token: "synthetic-actor-a" } }),
          );
          await page.route("**/api/tours/**", async (route) => {
            const path = new URL(route.request().url()).pathname;
            if (route.request().method() === "GET") ++reads;
            if (path === "/api/tours/selection-cart" && state === "Saved" && revision > 0) await readbackGate;
            if (path === "/api/tours/library")
              return route.fulfill({ json: { data: { tours: [row] }, csrf_token: scope } });
            if (path === "/api/tours/detail")
              return route.fulfill({
                json: {
                  data: { ...row, cheat_sheet: revision ? { revision_number: revision, content: { notes } } : {} },
                  csrf_token: "synthetic-actor-a",
                },
              });
            if (path === "/api/tours/cheat-sheet/autosave") {
              const body = route.request().postDataJSON();
              writes.push(body);
              if (state.startsWith("Saving")) await gate;
              if (!state.endsWith("failure")) {
                notes = body.content.notes;
                ++revision;
              }
              try {
                await route.fulfill(
                  state.endsWith("failure")
                    ? { status: 503, json: { error: "synthetic_unavailable" } }
                    : {
                        json: {
                          data: { cheat_sheet_revision_id: receipt, revision_number: revision },
                          csrf_token: "synthetic-actor-a",
                        },
                      },
                );
              } finally {
                finished();
              }
              return;
            }
            return route.fulfill({ status: 404, json: { error: "not_found" } });
          });
          await page.goto(`${server.url}/deals`);
          await page.evaluate(
            async ({ source, deal }) => {
              const { mountDealTours } = await import("data:text/javascript;base64," + source);
              const plannerModule = "/tours/planner-client.js";
              const {
                createPlannerClient,
              }: {
                createPlannerClient(): Parameters<typeof MountDealTours>[1]["client"] & { library(): Promise<unknown> };
              } = await import(plannerModule);
              history.replaceState(null, "", `/deals?deal=${deal}&tab=tours`);
              document.body.innerHTML = '<main id="retirement-workspace"></main>';
              window.editorRetirementClient = createPlannerClient();
              window.editorRetirementNavigations = 0;
              window.editorRetirementPanel = mountDealTours(document.querySelector("main"), {
                dealId: deal,
                client: window.editorRetirementClient,
                navigate(url: URL) {
                  ++window.editorRetirementNavigations;
                  history.replaceState(null, "", url);
                },
              });
            },
            { source: bundle.toString("base64"), deal },
          );
          await page.locator("[data-open-tour]").click();
          const editor = page.frameLocator("iframe");
          await editor.locator("#tour-name").filter({ hasText: row.name }).waitFor();
          await page.waitForLoadState("networkidle");
          await editor.locator("#cheat-content").fill("Synthetic unsaved packet notes");
          assert.equal(await editor.locator("#cheat-content").inputValue(), "Synthetic unsaved packet notes");
          assert.equal(await page.evaluate(() => window.editorRetirementPanel.hasUnsavedChanges()), true);
          if (state !== "Dirty") {
            const request = page.waitForRequest((request) => request.url().includes("/api/tours/cheat-sheet/autosave"));
            await editor.locator("#save-sheet").click();
            await request;
            if (state === "Saved") {
              await editor
                .locator("#sheet-state")
                .filter({ hasText: /save confirmed/ })
                .waitFor();
              assert.equal(
                await page.evaluate(() => window.editorRetirementPanel.hasUnsavedChanges()),
                true,
                "Visible save confirmation precedes the parent leave acknowledgement while readback is held",
              );
              let ready = false;
              const acquisition = savedEditorReady(page).then(() => {
                ready = true;
              });
              await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
              );
              assert.equal(ready, false, "Do not retire Saved until the parent acknowledges the completed save");
              releaseReadback();
              await acquisition;
              assert.equal(await page.evaluate(() => window.editorRetirementPanel.hasUnsavedChanges()), false);
            } else {
              await editor.locator("#sheet-state").filter({ hasText: "Saving…" }).waitFor();
              assert.equal(await editor.locator("#save-sheet").isDisabled(), true);
            }
            assert.equal(writes.length, 1);
            const write = writes[0];
            assert.ok(write);
            assert.equal(write.tour_id, tour);
            assert.equal(write.expected_revision_number, 0);
            assert.match(write.idempotency_key, /^[0-9a-f-]{36}$/i);
          }
          const before = await page.evaluate(() => {
            const frame = document.querySelector("iframe");
            if (!frame) throw Error("Fixture editor missing");
            window.editorRetirementFrame = frame.contentWindow;
            window.editorRetirementGeneration = Number(new URL(frame.src).searchParams.get("generation"));
            window.editorRetirementControls = [...document.querySelectorAll<HTMLButtonElement>("main button")];
            return { url: location.href, navigations: window.editorRetirementNavigations };
          });
          if (reason === "session")
            await page.evaluate(() => dispatchEvent(new Event("doctorcre-session-invalidated")));
          else {
            scope = "synthetic-actor-b";
            await page.evaluate(() => window.editorRetirementClient.library());
          }
          const readsAtRetirement = reads;
          assert.equal(await page.locator("main iframe").count(), 0, `${state} must remove its editor on ${reason}`);
          assert.equal(await page.locator("main button").count(), 0);
          await page.getByRole("status").filter({ hasText: "Your session has changed." }).waitFor();
          if (state.startsWith("Saving")) {
            release();
            await responded;
          }
          await page.evaluate(async (tour) => {
            for (const button of window.editorRetirementControls) button.click();
            dispatchEvent(
              new MessageEvent("message", {
                origin: location.origin,
                source: window.editorRetirementFrame,
                data: { type: "deal-tour-opened", id: tour, generation: window.editorRetirementGeneration },
              }),
            );
            await window.editorRetirementPanel.refresh();
          }, receipt);
          await page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          assert.equal(reads, readsAtRetirement, "Retired editor must not issue follow-up reads");
          assert.equal(writes.length, state === "Dirty" ? 0 : 1, "Retirement must not replay a pending write");
          assert.deepEqual(
            await page.evaluate(() => ({ url: location.href, navigations: window.editorRetirementNavigations })),
            before,
          );
          assert.equal(await page.locator("main iframe, main button").count(), 0);
          assert.equal(await page.evaluate(() => window.editorRetirementPanel.hasUnsavedChanges()), false);
          assert.equal(await page.evaluate(() => window.editorRetirementPanel.confirmLeave()), true);
          await page.evaluate(() => window.editorRetirementPanel.dispose());
        } catch (error) {
          console.error(
            state,
            reason,
            error,
            await Promise.all(
              page.frames().map((frame) =>
                frame
                  .locator("body")
                  .textContent()
                  .catch(() => "closed"),
              ),
            ),
          );
          throw error;
        } finally {
          release();
          releaseReadback();
          await page.close();
        }
      });
    }
});
