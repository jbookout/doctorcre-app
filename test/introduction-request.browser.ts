import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { relationshipNetworkFixture } from "../js/relationship-network-fixture.js";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { observeIntroduction, prove as proveIntroduction } from "../scripts/prove-introduction-review.ts";
import type { mountIntroductionRequest as MountIntroductionRequest } from "../src/ui/introduction-request.ts";
import { chromium, componentDocument } from "./browser-harness.mjs";
import introRecording from "./fixtures/introduction-request.json" with { type: "json" };

const assets = await appAssetSnapshot();
const relationshipPage = assets.get("/relationships.html");
assert.ok(relationshipPage);
async function open(t: TestContext, width = 1440, paceMs = 0) {
  assert.ok(relationshipPage);
  const server = await startWorkerFixture({
    routes: new Map([
      ...assets,
      ["/relationships", relationshipPage],
      ["/", relationshipPage],
      [
        "/app-release",
        {
          contentType: "application/json",
          body: Buffer.from(
            JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: "1".repeat(40) }),
          ),
        },
      ],
    ]),
  });
  t.after(() => server.close());
  const origin = server.origin;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
  const errors: string[] = [];
  const writes: {
    from_party: string;
    to_party: string;
    via_party?: string;
    kind: string;
    note: string;
    occurred_on: string;
  }[] = [];
  let recorded: ReturnType<typeof relationshipNetworkFixture>["edges"][number] | null = null;
  let mode = "intro";
  page.on("pageerror", (e) => errors.push(e.message));
  let dispatch = Promise.resolve();
  let requestCount = 0;
  await page.route("**/*", async (r) => {
    requestCount++;
    if (paceMs) {
      dispatch = dispatch.then(() => delay(paceMs));
      await dispatch;
    }
    const url = new URL(r.request().url());
    if (url.origin !== origin) return r.abort();
    if (url.pathname === "/api/v1/business/relationships") {
      const payload: ReturnType<typeof relationshipNetworkFixture> = structuredClone(introRecording.snapshot);
      payload.observed_at = new Date().toISOString();
      payload.valid_until = new Date(Date.now() + 120000).toISOString();
      if (recorded) {
        payload.edges.push(recorded);
        payload.suggestions = [];
      }
      return r.fulfill({ json: payload });
    }
    if (["/api/system-work/session", "/auth/session"].includes(url.pathname))
      return r.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic-session" } });
    if (url.pathname === "/mcp") {
      const body = r.request().postDataJSON();
      let payload: unknown = { ok: true };
      if (body.params.name === "link-parties") {
        const args = body.params.arguments;
        writes.push(args);
        recorded = {
          id: `link:${introRecording.created.link_id}`,
          from: `party:${args.from_party}`,
          to: `party:${args.to_party}`,
          via: args.via_party ? `party:${args.via_party}` : null,
          kind: "intro_requested",
          detail: args.note,
          summary: args.note,
          when: `${args.occurred_on}T00:00:00Z`,
        };
        if (mode === "intro-lost" && writes.length === 1) return r.abort();
        payload = structuredClone(writes.length > 1 ? introRecording.replayed : introRecording.created);
      }
      if (body.params.name === "read-home-agenda")
        payload = { schema_version: "home-agenda.v1", deals: [], actor: "joe" };
      if (body.params.name === "deal-room-board") payload = { deals: [], actor: "joe" };
      if (body.params.name === "today-triage") payload = { items: [] };
      if (body.params.name === "deal-room-changes") payload = { events: [], cursor: null };
      return r.fulfill({
        json: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } },
      });
    }
    if (url.pathname.startsWith("/api/")) return r.fulfill({ json: {} });
    return r.continue();
  });
  await mkdir("out/test-artifacts/w14", { recursive: true });
  return {
    page,
    origin,
    errors,
    requestCount: () => requestCount,
    writes,
    setMode: (value: string) => {
      mode = value;
    },
  };
}
for (const width of [1440, 390])
  for (const theme of ["light", "dark"])
    test(`V03 explicitly reviews and records the exact introduction at ${width} ${theme}`, async (t) => {
      const { page, origin, setMode, writes, errors } = await open(t, width);
      setMode("intro");
      await page.addInitScript(
        (theme) =>
          localStorage.setItem(
            "doctorcre.visual-preferences",
            JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } }),
          ),
        theme,
      );
      await page.goto(`${origin}/relationships?mode=live`);
      await page.locator("#networkIntroductions [data-node]").click();
      await page.locator("[data-review-introduction]").click();
      const panel = page.locator(".introduction-review");
      assert.equal(await panel.getAttribute("data-state"), "reviewing");
      assert.equal(writes.length, 0);
      assert.ok(
        ((await panel.boundingBox())?.width ?? Infinity) <= Math.min(620, width - 24) + 1,
        "the review panel keeps its intended width inside the app shell",
      );
      assert.deepEqual(await panel.locator("[data-identity]").allTextContents(), [
        "Demo Healthcare Lending (DEMO-FROM)",
        "Demo Practice Builders (DEMO-VIA)",
        "Demo Dental Expansion (DEMO-TO)",
      ]);
      await panel.locator('[name="date"]').fill("2026-11-10");
      await panel.locator('[name="note"]').fill("Please connect these practices.");
      await panel.locator('[type="submit"]').click();
      assert.equal(writes.length, 0);
      await panel.locator('[name="reviewed"]').check();
      assert.equal(await panel.evaluate((n) => n.scrollWidth <= n.clientWidth), true);
      await page.screenshot({
        path: `out/test-artifacts/w14/intro-review-${width}-${theme}.png`,
        animations: "disabled",
      });
      await panel.locator('[type="submit"]').click();
      await page.waitForFunction(
        () => document.querySelector<HTMLElement>(".introduction-review")?.dataset.state === "confirmed",
      );
      assert.equal(writes.length, 1);
      assert.equal(writes[0]?.from_party, "11111111-1111-4111-8111-111111111111");
      assert.equal(writes[0]?.to_party, "22222222-2222-4222-8222-222222222222");
      assert.equal(writes[0]?.via_party, "33333333-3333-4333-8333-333333333333");
      assert.equal(writes[0]?.kind, "intro_requested");
      await panel.locator("[data-close]").click();
      await page.waitForFunction(() =>
        document
          .querySelector(".relationship-dialog:not(.introduction-review)")
          ?.textContent?.includes("Introduction requested"),
      );
      assert.deepEqual(errors, []);
    });

test("V03 lost response survives closing and refresh then replays the same session-bound request", async (t) => {
  const { page, origin, setMode, writes, errors } = await open(t, 390);
  setMode("intro-lost");
  await page.goto(`${origin}/relationships?mode=live`);
  await page.locator("#networkIntroductions [data-node]").click();
  await page.locator("[data-review-introduction]").click();
  const panel = page.locator(".introduction-review");
  await panel.locator('[name="date"]').fill("2026-11-10");
  await panel.locator('[name="note"]').fill("Retain this request.");
  await panel.locator('[name="reviewed"]').check();
  await panel.locator('[type="submit"]').click();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>(".introduction-review")?.dataset.state === "unknown",
  );
  await panel.locator("[data-close]").click();
  await page.keyboard.press("Escape");
  await page.locator("#networkRefresh").click();
  await page.getByRole("button", { name: "Check introduction request", exact: true }).click();
  assert.equal(await panel.locator('[name="note"]').isDisabled(), true);
  await panel.locator("[data-recover]").click();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>(".introduction-review")?.dataset.state === "confirmed",
  );
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.deepEqual(errors, []);
});

test("V03 changed-session recovery sends no second write and clears private review identities", async (t) => {
  const { page, origin, setMode, writes } = await open(t, 390);
  setMode("intro-lost");
  await page.goto(`${origin}/relationships?mode=live`);
  await page.locator("#networkIntroductions [data-node]").click();
  await page.locator("[data-review-introduction]").click();
  const panel = page.locator(".introduction-review");
  await panel.locator('[name="date"]').fill("2026-11-10");
  await panel.locator('[name="note"]').fill("Retain this request.");
  await panel.locator('[name="reviewed"]').check();
  await panel.locator('[type="submit"]').click();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>(".introduction-review")?.dataset.state === "unknown",
  );
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "dell" }, csrf_token: "synthetic-replacement-session" } }),
  );
  await panel.locator("[data-recover]").click();
  await page.waitForURL("**/public-shell/session-ended.html");
  assert.equal(writes.length, 1);
  assert.equal(await page.locator(".introduction-review,[data-identity]").count(), 0);
});

test("V03 retiring the review clears private notes and prevents reopening their values", async (t) => {
  const { page, origin } = await open(t);
  await componentDocument(page, origin, {
    html: '<main id="recovery"></main>',
    dispose: () => handle.evaluate((model) => model.dispose()),
  });
  const handle = await page.evaluateHandle(async (recording) => {
    const { mountIntroductionRequest } = await import(String("/js/ui-relationship-kind-filter.js"));
    const { validNetwork } = await import(String("/js/relationship-network-model.js"));
    recording.snapshot.observed_at = new Date().toISOString();
    recording.snapshot.valid_until = new Date(Date.now() + 120000).toISOString();
    const model: ReturnType<typeof MountIntroductionRequest> = mountIntroductionRequest({
      document,
      validNetwork,
      client: { getRelationshipNetwork: async () => recording.snapshot, linkParties: async () => recording.created },
      onConfirmed: () => {},
      recoveryHost: document.querySelector("main"),
    });
    model.open(recording.snapshot, recording.snapshot.suggestions[0]?.id ?? "");
    return model;
  }, introRecording);
  const panel = page.locator(".introduction-review");
  await panel.locator('[name="date"]').fill("2026-11-10");
  await panel.locator('[name="note"]').fill("Private synthetic note");
  await handle.evaluate((model) => model.retire());
  assert.equal(await panel.locator('[name="note"]').inputValue(), "");
  assert.equal(await panel.locator('[name="date"]').inputValue(), "");
  assert.equal(await panel.locator("[data-identity]").count(), 0);
  await handle.evaluate((model) => model.open({}, "ignored"));
  assert.equal(await panel.isVisible(), true);
  assert.equal(await panel.locator('[name="note"]').inputValue(), "");
  assert.equal(await panel.locator('[name="reviewed"]').isChecked(), false);
  assert.equal(await panel.locator('[type="submit"]').isDisabled(), true);
});

for (const mismatch of [false, true])
  test(`V03 proof observation ${mismatch ? "rejects near-miss identity" : "passes exact identity"}`, async (t) => {
    const { page, origin, setMode, writes } = await open(t);
    setMode("intro");
    if (mismatch)
      await page.addInitScript(() => {
        const observer = new MutationObserver(() => {
          const node = document.querySelector(".introduction-review dd");
          if (node && !node.textContent.startsWith("Wrong ")) node.textContent = `Wrong ${node.textContent}`;
        });
        observer.observe(document, { subtree: true, childList: true });
      });
    await page.goto(`${origin}/relationships?mode=live`);
    if (mismatch) await assert.rejects(() => observeIntroduction(page), /Expected values to be strictly deep-equal/);
    else assert.equal((await observeIntroduction(page)).status, "passed");
    assert.equal(writes.length, 0);
  });

for (const mismatch of [false, true])
  test(`V03 complete proof runner ${mismatch ? "fails an exact identity mismatch" : "passes all viewport and theme observations"}`, async (t) => {
    const commit = "1".repeat(40);
    const { page, origin, setMode, writes } = await open(t, 1440);
    setMode("intro");
    if (mismatch)
      await page.addInitScript(() => {
        new MutationObserver(() => {
          const n = document.querySelector(".introduction-review dd");
          if (n && !n.textContent.startsWith("Wrong ")) n.textContent = `Wrong ${n.textContent}`;
        }).observe(document, { subtree: true, childList: true });
      });
    let requests = 0;
    let navigations = 0;
    page.on("request", () => requests++);
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
    });
    const run = () =>
      proveIntroduction({
        origin,
        expectedCommit: commit,
        engine: {
          launch: async () => ({
            newPage: async () => page,
            close: async () => {
              await page.close();
            },
          }),
        },
      });
    if (mismatch) await assert.rejects(run, /Expected values to be strictly deep-equal/);
    else {
      const receipt = await run();
      assert.equal(receipt.status, "passed");
      assert.equal(receipt.observations.length, 4);
      console.log(JSON.stringify({ requests, navigations }));
      assert.equal(navigations, 1, "reuse the app download across widths and themes");
    }
    assert.equal(writes.length, 0);
    assert.equal(page.isClosed(), true);
  });

for (const scenario of ["late launch", "stalled evaluation"])
  test(`V03 proof deadline closes its page after ${scenario}`, async (t) => {
    const commit = "1".repeat(40);
    const { page, origin, setMode } = await open(t, 390);
    setMode("intro");
    const { promise: pending, resolve: release } = Promise.withResolvers<void>();
    const evaluate = page.evaluate.bind(page);
    if (scenario === "stalled evaluation") {
      page.goto = async () => null;
      page.setViewportSize = async () => {};
      page.evaluate = () => pending;
    }
    let closed = 0;
    const engine = {
      launch: async () => {
        if (scenario === "late launch") await delay(1200);
        return {
          newPage: async () => page,
          close: async () => {
            closed++;
            page.evaluate = evaluate;
            await page.close();
            release();
          },
        };
      },
    };
    await assert.rejects(
      () => proveIntroduction({ origin, expectedCommit: commit, engine, timeoutMs: 1000 }),
      (error: unknown) => !!error && typeof error === "object" && "exitCode" in error && error.exitCode === 78,
    );
    assert.equal(closed, 1);
    assert.equal(page.isClosed(), true);
  });

test("V03 paced proof finishes within the original total deadline", async (t) => {
  const { page, origin, requestCount } = await open(t, 1440, 110);
  try {
    const result = await proveIntroduction({
      origin,
      expectedCommit: "1".repeat(40),
      engine: {
        launch: async () => ({
          newPage: async () => page,
          close: async () => {
            await page.close();
          },
        }),
      },
    });
    assert.equal(result.observations.length, 4);
  } finally {
    console.log(JSON.stringify({ pacedRequests: requestCount() }));
  }
});
