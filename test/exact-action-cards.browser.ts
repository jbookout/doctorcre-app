import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv } from "ajv";
import { chromium, type Page } from "playwright";
import { CHROMIUM_SAFETY_ARGS } from "../scripts/chromium-safety-args.mjs";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { proveExact } from "../scripts/prove-exact-action-cards.ts";
import { cdpEndpoint } from "./cdp-fixture.ts";

const rows: {
  ref: string;
  card: {
    state?: string;
    actions?: unknown[];
    id: string;
    kind: "reply_draft" | "post_call_review" | "feedback_event";
  };
}[] = JSON.parse(await readFile("test/fixtures/action-card-targets.v2.json", "utf8"));
const reply: (typeof rows)[number] = JSON.parse(await readFile("test/fixtures/action-link-reply.v2.json", "utf8"));
const call = rows[0],
  feedback = rows[1];
assert.ok(call && feedback);
const cards = [reply, call, feedback];
const targets = cards.map((value) => ({ ref: value.ref, id: value.card.id, kind: value.card.kind }));
const commit = "1".repeat(40),
  foreignRef = `al1_${Buffer.from(`rd:${reply.card.id}:dell:1`).toString("base64url")}`;
const writeInput = new Ajv().compile(
  JSON.parse(await readFile("test/fixtures/review-call-outcome.input.json", "utf8")),
);
const reviewContract = JSON.parse(await readFile("contracts/carr-interface.v1/review-call-outcome.v1.json", "utf8"));
const writeResponse = new Ajv().compile(reviewContract.responseSchema);
const writeRefusal = new Ajv().compile(reviewContract.refusalSchema);
const cardContract = new Ajv({ strict: false, validateFormats: false }).compile(
  JSON.parse(await readFile("contracts/carr-interface.v1/action-link-resolve.v2.json", "utf8")),
);
for (const row of cards) assert.ok(cardContract(row), JSON.stringify(cardContract.errors));
const assets = await appAssetSnapshot();
async function fixture() {
  const routes = new Map(assets);
  routes.set("/app-release", {
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: commit })),
  });
  const calls: string[] = [];
  const server = await startWorkerFixture({
    routes,
    env: {
      CARR: {
        async fetch(request: Request) {
          const url = new URL(request.url);
          if (url.pathname === "/auth/session")
            return Response.json({ actor: { slug: "joe" }, csrf_token: "synthetic-csrf" });
          if (url.pathname === "/mcp") {
            const rpc = await request.json();
            assert.ok(
              typeof rpc === "object" &&
                rpc !== null &&
                "id" in rpc &&
                "params" in rpc &&
                typeof rpc.params === "object" &&
                rpc.params !== null &&
                "name" in rpc.params &&
                "arguments" in rpc.params &&
                typeof rpc.params.arguments === "object" &&
                rpc.params.arguments !== null,
            );
            calls.push(String(rpc.params.name));
            const value =
              "ref" in rpc.params.arguments ? cards.find((c) => c.ref === rpc.params.arguments.ref) : undefined;
            return Response.json({
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                content: [{ type: "text", text: JSON.stringify(value || { error: "action_link_not_found" }) }],
              },
            });
          }
          return new Response(null);
        },
      },
    },
  });
  return { ...server, calls };
}
async function gotoEndedSession(page: Page, url: string) {
  await page.goto(url);
  await page.waitForURL("**/public-shell/session-ended.html?**");
}

test("session refusal replaces initial navigation before its pending load and discloses no private card", async () => {
  const server = await fixture();
  const browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  try {
    const page = await browser.newPage();
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) events.push(new URL(frame.url()).pathname);
    });
    await page.route("**/a/**", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace("</body>", '<img src="/held-initial-load"></body>'),
      });
    });
    await page.route("**/held-initial-load", async (route) => {
      await gate;
      await route.fulfill({ body: "" });
    });
    await page.route("**/auth/session", async (route) => {
      events.push("session 401");
      await route.fulfill({ status: 401, json: { error: "not_authenticated" } });
    });
    await gotoEndedSession(page, `${server.origin}/a/${call.ref}?mode=live`);
    assert.deepEqual(events.slice(0, 3), [`/a/${call.ref}`, "session 401", "/public-shell/session-ended.html"]);
    assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
    const login = page.locator("a[href*=return_to]");
    await login.waitFor();
    assert.equal(
      new URL((await login.getAttribute("href")) || "", server.origin).searchParams.get("return_to"),
      `/a/${call.ref}`,
    );
  } finally {
    release();
    await browser.close();
    await server.close();
  }
});

test("cold navigation and existing tab show all three exact cards without inbox reads at phone and desktop sizes", async () => {
  const server = await fixture(),
    browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    await mkdir("/tmp/J183-screenshots", { recursive: true });
    for (const width of [390, 1440])
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        await page.addInitScript((theme) => localStorage.setItem("dealroom-theme", theme), theme);
        for (const target of targets) {
          await page.goto(`${server.origin}/a/${target.ref}?mode=live`);
          const node = page.locator("[data-exact-card-id]");
          await node.waitFor();
          if (target.kind === "post_call_review")
            await page.getByText("Send the revised lease proposal", { exact: true }).waitFor();
          assert.equal(await node.getAttribute("data-exact-card-id"), target.id);
          assert.equal(await node.getAttribute("data-exact-card-kind"), target.kind);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          await page.screenshot({ path: `/tmp/J183-screenshots/${target.kind}-${width}-${theme}.png`, fullPage: true });
        }
        await page.close();
      }
    assert.ok(server.calls.filter((name) => name === "resolve-action-link-v2").length >= 12);
    assert.equal(server.calls.includes("read-home-inbox"), false);
  } finally {
    await browser.close();
    await server.close();
  }
});
test("wrong partner malformed near-match offline and expired session disclose no card; sign-in preserves reference", async () => {
  const server = await fixture(),
    browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    const page = await browser.newPage();
    for (const ref of [foreignRef, `${call.ref}A`, "al1_bad"]) {
      await page.goto(`${server.origin}/a/${ref}?mode=live`);
      await page.getByText(/unavailable for your account|invalid|could not be opened/).waitFor();
      assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
    }
    await page.route("**/mcp", (route) => route.abort("internetdisconnected"));
    await page.goto(`${server.origin}/a/${call.ref}?mode=live`);
    await page.getByText("The draft could not be opened.", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
    await page.unroute("**/mcp");
    await page.route("**/auth/login?**", async (route) => {
      const destination = new URL(route.request().url()).searchParams.get("return_to");
      assert.equal(destination, `/a/${call.ref}`);
      await page.unroute("**/auth/session");
      await route.fulfill({ status: 302, headers: { location: `${destination}?mode=live` }, body: "" });
    });
    await page.route("**/auth/session", (route) =>
      route.fulfill({ status: 401, json: { error: "not_authenticated" } }),
    );
    await page.goto(`${server.origin}/a/${call.ref}?mode=live`);
    await page.waitForURL("**/public-shell/session-ended.html?**");
    const login = page.locator("a[href*=return_to]");
    await login.waitFor();
    assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
    assert.equal(
      new URL((await login.getAttribute("href")) || "", server.origin).searchParams.get("return_to"),
      `/a/${call.ref}`,
    );
    await login.click();
    await page.waitForURL(`${server.origin}/a/${call.ref}?mode=live`);
    await page.locator("[data-exact-card-id]").waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
    assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
  } finally {
    await browser.close();
    await server.close();
  }
});
test("exact-card proof containing release passes and near-match fails; unavailable registered read is insufficient", async () => {
  const server = await fixture();
  try {
    assert.equal(
      (await proveExact({ origin: server.origin, commit, targets, foreignRef, engine: chromium })).status,
      "passed",
    );
    await assert.rejects(
      proveExact({
        origin: server.origin,
        commit,
        targets: targets.map((t, i) => (i === 0 ? { ...t, id: `${t.id}f` } : t)),
        foreignRef,
        engine: chromium,
      }),
    );
    await assert.rejects(
      proveExact({
        origin: server.origin,
        commit,
        targets: targets.map((t, i) => (i === 0 ? { ...t, ref: foreignRef } : t)),
        foreignRef,
        engine: chromium,
      }),
      { exitCode: 78 },
    );
  } finally {
    await server.close();
  }
});

test("production proof CLI exits 0, 1 and 78 through a real browser fixture", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const server = await fixture(),
    browser = await chromium.launch({
      headless: true,
      args: [...CHROMIUM_SAFETY_ARGS, "--remote-debugging-port=0", "--enable-automation"],
    });
  try {
    const endpoint = await cdpEndpoint(browser);
    const args = [
      "scripts/prove-exact-action-cards.ts",
      "--origin",
      server.origin,
      "--commit",
      commit,
      "--reply-ref",
      reply.ref,
      "--reply-id",
      reply.card.id,
      "--call-ref",
      call.ref,
      "--call-id",
      call.card.id,
      "--feedback-ref",
      feedback.ref,
      "--feedback-id",
      feedback.card.id,
      "--foreign-ref",
      foreignRef,
      "--cdp-url",
      endpoint,
    ];
    assert.equal(JSON.parse((await exec(process.execPath, args, { timeout: 45000 })).stdout).status, "passed");
    const wrong = [...args];
    wrong[wrong.indexOf("--call-id") + 1] = `${call.card.id.slice(0, -1)}f`;
    await assert.rejects(
      exec(process.execPath, wrong, { timeout: 45000 }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 1,
    );
    const missing = [...args];
    missing[missing.indexOf("--call-ref") + 1] = foreignRef;
    await assert.rejects(
      exec(process.execPath, missing, { timeout: 45000 }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 78,
    );
  } finally {
    await browser.close();
    await server.close();
  }
});

test("post-call review uses registered input and receipt and retains its intent key after a lost response and reload", async () => {
  const server = await fixture(),
    browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    const page = await browser.newPage();
    const keys: string[] = [];
    let reviewed = false;
    await page.route("**/mcp", async (route) => {
      const rpc = route.request().postDataJSON();
      let payload = structuredClone(call);
      if (rpc.params.name === "review-call-outcome") {
        assert.ok(writeInput(rpc.params.arguments), JSON.stringify(writeInput.errors));
        assert.equal(rpc.params.arguments.session_id, call.card.id);
        assert.equal(rpc.params.arguments.expected_source_version, "4392d9ee99a3e7940999c568bd4c7b61");
        assert.match(rpc.params.arguments.idempotency_key, /^[0-9a-f-]{36}$/);
        keys.push(rpc.params.arguments.idempotency_key);
        if (keys.length === 1) {
          await route.abort("failed");
          return;
        }
        reviewed = true;
        const reviewReceipt = { ok: true, session_id: call.card.id, reviewed: true, replayed: true };
        assert.ok(writeResponse(reviewReceipt), JSON.stringify(writeResponse.errors));
        await route.fulfill({
          json: {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(reviewReceipt) }],
            },
          },
        });
        return;
      }
      if (reviewed) payload = { ...payload, card: { ...payload.card, state: "resolved", actions: [] } };
      await route.fulfill({
        json: { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } },
      });
    });
    await page.goto(`${server.origin}/a/${call.ref}?mode=live`);
    await page.getByRole("button", { name: "Mark call reviewed", exact: true }).click();
    await page.getByText("Review was not confirmed. Reload before trying again.", { exact: true }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "Mark call reviewed", exact: true }).click();
    await page.getByText("Resolved", { exact: true }).waitFor();
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(await page.evaluate((ref) => sessionStorage.getItem(`doctorcre-review:${ref}`), call.ref), null);
  } finally {
    await browser.close();
    await server.close();
  }
});
for (const phase of ["late launch", "stalled evaluation"])
  test(`exact-card deadline closes owned browser for ${phase}`, async () => {
    const server = await fixture();
    let owned: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const engine = {
        async launch(options: { timeout: number; args: string[] }) {
          const browser = await chromium.launch({
            ...options,
            headless: true,
            args: [...CHROMIUM_SAFETY_ARGS, ...options.args],
          });
          owned = browser;
          if (phase === "late launch") await new Promise((resolve) => setTimeout(resolve, 1500));
          else {
            const newPage = browser.newPage.bind(browser);
            browser.newPage = async () => {
              const page = await newPage();
              page.evaluate = () => new Promise<never>(() => {});
              return page;
            };
          }
          return browser;
        },
      };
      await assert.rejects(
        proveExact({ origin: server.origin, commit, targets, foreignRef, engine, timeoutMs: 1000 }),
        { exitCode: 78 },
      );
      assert.equal(owned?.isConnected(), false);
    } finally {
      await owned?.close();
      await server.close();
    }
  });

for (const lifecycle of ["pending_review", "resolved", "stale", "retired", "unavailable"]) {
  test(`mounted ${lifecycle} card clears on session refusal`, async () => {
    const server = await fixture(),
      browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
    try {
      const page = await browser.newPage();
      await page.route("**/mcp", (route) => {
        const rpc = route.request().postDataJSON();
        const payload =
          lifecycle === "unavailable"
            ? { error: "action_link_not_found" }
            : {
                ...call,
                card: {
                  ...call.card,
                  state: lifecycle,
                  actions: lifecycle === "pending_review" ? call.card.actions : [],
                  ...(lifecycle === "retired" ? { detail: null } : {}),
                },
              };
        return route.fulfill({
          json: { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } },
        });
      });
      await page.goto(`${server.origin}/a/${call.ref}?mode=live`);
      if (lifecycle === "unavailable")
        await page.getByText("This draft is unavailable for your account.", { exact: true }).waitFor();
      else {
        await page.locator("[data-exact-card-id]").waitFor();
        const status =
          lifecycle === "stale"
            ? "This card changed. Open its current version before acting."
            : lifecycle === "retired"
              ? "This source is no longer available."
              : lifecycle === "resolved"
                ? "Resolved"
                : "Awaiting your review";
        await page.getByText(status, { exact: true }).waitFor();
        assert.equal(
          await page.getByRole("button", { name: "Mark call reviewed", exact: true }).count(),
          lifecycle === "pending_review" ? 1 : 0,
        );
      }
      await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
      assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
      assert.equal(await page.getByRole("button", { name: "Mark call reviewed", exact: true }).count(), 0);
    } finally {
      await browser.close();
      await server.close();
    }
  });
}

for (const receipt of [
  { ok: true },
  { ok: true, reviewed: true, session_id: "foreign" },
  { error: "partner_required" },
  { ok: true, session_id: call.card.id, reviewed: true, error: "partner_required" },
  { ok: true, session_id: call.card.id, reviewed: true, extra: true },
  { ok: true, session_id: call.card.id, reviewed: true, already: "reviewed" },
])
  test(`post-call review refuses unconfirmed receipt ${JSON.stringify(receipt)}`, async () => {
    const server = await fixture(),
      browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
    try {
      const page = await browser.newPage();
      let reads = 0;
      const keys: string[] = [];
      await page.route("**/mcp", (route) => {
        const rpc = route.request().postDataJSON();
        const write = rpc.params.name === "review-call-outcome";
        if (write) {
          assert.ok(writeInput(rpc.params.arguments));
          keys.push(rpc.params.arguments.idempotency_key);
        } else if (rpc.params.name === "resolve-action-link-v2") reads++;
        return route.fulfill({
          json: {
            jsonrpc: "2.0",
            id: rpc.id,
            result: { content: [{ type: "text", text: JSON.stringify(write ? receipt : call) }] },
          },
        });
      });
      await page.goto(`${server.origin}/a/${call.ref}?mode=live`);
      await page.getByRole("button", { name: "Mark call reviewed", exact: true }).click();
      await page.getByText("Review was not confirmed. Reload before trying again.", { exact: true }).waitFor();
      assert.equal(reads, 1);
      assert.equal(await page.getByText("Resolved", { exact: true }).count(), 0);
      await page.reload();
      await page.getByRole("button", { name: "Mark call reviewed", exact: true }).click();
      await page.getByText("Review was not confirmed. Reload before trying again.", { exact: true }).waitFor();
      assert.equal(keys.length, 2);
      assert.equal(keys[0], keys[1]);
    } finally {
      await browser.close();
      await server.close();
    }
  });

test("post-call review retries immediately from the unconfirmed view with the same intent", async () => {
  const server = await fixture(),
    browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    const page = await browser.newPage();
    const commands: Record<string, unknown>[] = [];
    const operations: string[] = [];
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    await page.route("**/mcp", async (route) => {
      const rpc = route.request().postDataJSON();
      if (!["review-call-outcome", "resolve-action-link-v2"].includes(rpc.params.name)) return route.fallback();
      operations.push(rpc.params.name);
      let payload: unknown;
      if (rpc.params.name === "review-call-outcome") {
        assert.ok(writeInput(rpc.params.arguments), JSON.stringify(writeInput.errors));
        commands.push(rpc.params.arguments);
        if (commands.length === 1) return route.fulfill({ status: 503, json: { error: "synthetic_unavailable" } });
        assert.deepEqual(operations, ["resolve-action-link-v2", "review-call-outcome", "review-call-outcome"]);
        payload = { ok: true, session_id: call.card.id, reviewed: true };
        assert.ok(writeResponse(payload), JSON.stringify(writeResponse.errors));
      } else {
        payload = commands.length === 2 ? { ...call, card: { ...call.card, state: "resolved", actions: [] } } : call;
        assert.ok(cardContract(payload), JSON.stringify(cardContract.errors));
      }
      return route.fulfill({
        json: {
          jsonrpc: "2.0",
          id: rpc.id,
          result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
        },
      });
    });
    await page.goto(`${server.origin}/a/${call.ref}?mode=live`);
    const review = page.getByRole("button", { name: "Mark call reviewed", exact: true });
    await review.click();
    await page.getByText("Review was not confirmed. Reload before trying again.", { exact: true }).waitFor();
    assert.deepEqual(operations, ["resolve-action-link-v2", "review-call-outcome"]);
    assert.equal(await page.getByText("Resolved", { exact: true }).count(), 0);
    await review.click();
    await page.getByText("Resolved", { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[1], commands[0], "retry preserves the exact command and its idempotency key");
    assert.equal(navigations, 1, "retry stays in the original document");
    assert.deepEqual(operations, [
      "resolve-action-link-v2",
      "review-call-outcome",
      "review-call-outcome",
      "resolve-action-link-v2",
    ]);
    assert.equal(await review.count(), 0);
  } finally {
    await browser.close();
    await server.close();
  }
});

for (const changed of [false, true])
  test(`atomic review ${changed ? "refuses an edit between display and write and reopens current version" : "accepts matching displayed version"}`, async () => {
    const server = await fixture(),
      browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
    try {
      const page = await browser.newPage();
      const sentKeys: string[] = [];
      let reads = 0,
        writes = 0,
        canonicalVersion = "4392d9ee99a3e7940999c568bd4c7b61";
      const currentRef = `al1_${Buffer.from(`cr:${call.card.id}:changed2`).toString("base64url")}`;
      await page.route("**/mcp", async (route) => {
        const rpc = route.request().postDataJSON();
        if (!["review-call-outcome", "resolve-action-link-v2"].includes(rpc.params.name)) return route.fallback();
        let payload: unknown;
        if (rpc.params.name === "review-call-outcome") {
          writes++;
          sentKeys.push(rpc.params.arguments.idempotency_key);
          if (writes === 2) {
            assert.ok(writeInput(rpc.params.arguments));
            assert.equal(rpc.params.arguments.expected_source_version, "changed2");
            await route.abort("failed");
            return;
          }
          if (changed) canonicalVersion = "changed2";
          assert.equal(reads, 1, "no separate preflight read");
          assert.ok(writeInput(rpc.params.arguments), JSON.stringify(writeInput.errors));
          assert.equal(rpc.params.arguments.expected_source_version, "4392d9ee99a3e7940999c568bd4c7b61");
          assert.equal(rpc.params.arguments.expected_source_version !== canonicalVersion, changed);
          payload = changed
            ? {
                error: "source_version_changed",
                correlation_id: "20000000-0000-4000-8000-000000000999",
                hint: reviewContract.refusal.hint,
              }
            : { ok: true, session_id: call.card.id, reviewed: true };
          const validate = changed ? writeRefusal : writeResponse;
          assert.ok(validate(payload), JSON.stringify(validate.errors));
        } else {
          reads++;
          payload =
            writes === 0
              ? call
              : changed
                ? {
                    ...call,
                    ref: rpc.params.arguments.ref,
                    card: {
                      ...call.card,
                      source_version: "changed2",
                      state: rpc.params.arguments.ref === currentRef ? "pending_review" : "stale",
                      actions: rpc.params.arguments.ref === currentRef ? call.card.actions : [],
                    },
                  }
                : { ...call, card: { ...call.card, state: "resolved", actions: [] } };
          assert.ok(cardContract(payload), JSON.stringify(cardContract.errors));
        }
        await route.fulfill({
          json: {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              isError: changed && rpc.params.name === "review-call-outcome",
              content: [{ type: "text", text: JSON.stringify(payload) }],
            },
          },
        });
      });
      await page.goto(`${server.origin}/a/${call.ref}?mode=live`);
      await page.getByRole("button", { name: "Mark call reviewed", exact: true }).waitFor();
      await page.getByRole("button", { name: "Mark call reviewed", exact: true }).click();
      if (changed) {
        await page.getByText("This card changed. Open its current version before acting.", { exact: true }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Mark call reviewed", exact: true }).count(), 0);
        assert.equal(await page.evaluate((ref) => sessionStorage.getItem(`doctorcre-review:${ref}`), call.ref), null);
        await page.getByRole("button", { name: "Open current version", exact: true }).click();
        await page.waitForURL(`**/a/${currentRef}*`);
        await page.getByRole("button", { name: "Mark call reviewed", exact: true }).waitFor();
        assert.equal(await page.locator("[data-source-version]").getAttribute("data-source-version"), "changed2");
      } else await page.getByText("Resolved", { exact: true }).waitFor();
      assert.equal(writes, 1);
      if (changed) {
        await page.getByRole("button", { name: "Mark call reviewed", exact: true }).click();
        await page.getByText("Review was not confirmed. Reload before trying again.", { exact: true }).waitFor();
        assert.equal(sentKeys.length, 2);
        assert.notEqual(sentKeys[0], sentKeys[1]);
      }
    } finally {
      await browser.close();
      await server.close();
    }
  });

for (const status of [401, 403])
  test(`review intent survives HTTP ${status} retirement without retaining private storage`, async () => {
    const server = await fixture(),
      browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
    try {
      const page = await browser.newPage();
      const keys: string[] = [];
      await page.route("**/mcp", async (route) => {
        const rpc = route.request().postDataJSON();
        if (rpc.params.name !== "review-call-outcome") return route.fallback();
        assert.ok(writeInput(rpc.params.arguments));
        keys.push(rpc.params.arguments.idempotency_key);
        return route.fulfill({ status, json: { error: "forbidden" } });
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        await page.goto(`${server.origin}/a/${call.ref}?mode=live`);
        await page.getByRole("button", { name: "Mark call reviewed", exact: true }).click();
        await page.waitForURL("**/public-shell/session-ended.html?**");
        assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
        assert.equal(await page.evaluate((ref) => sessionStorage.getItem(`doctorcre-review:${ref}`), call.ref), null);
      }
      assert.equal(keys.length, 2);
      assert.equal(keys[0], keys[1]);
    } finally {
      await browser.close();
      await server.close();
    }
  });

test("sign out erases private state and reopening under another principal derives a distinct review", async () => {
  const server = await fixture(),
    browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    const page = await browser.newPage();
    let actor = "joe";
    const keys: string[] = [];
    await page.route("**/auth/session", (route) =>
      route.fulfill({ json: { actor: { slug: actor }, csrf_token: `${actor}-csrf` } }),
    );
    await page.route("**/mcp", (route) => {
      const rpc = route.request().postDataJSON();
      if (rpc.params.name !== "review-call-outcome") return route.fallback();
      assert.ok(writeInput(rpc.params.arguments));
      keys.push(rpc.params.arguments.idempotency_key);
      return route.abort("failed");
    });
    for (const nextActor of ["joe", "joe", "dell"]) {
      actor = nextActor;
      await page.goto(`${server.origin}/a/${call.ref}?mode=live`);
      await page.getByRole("button", { name: "Mark call reviewed", exact: true }).click();
      await page.getByText("Review was not confirmed. Reload before trying again.", { exact: true }).waitFor();
      await page.evaluate(async () => {
        const modulePath: string = "/js/private-session.js";
        const { privateSession } = await import(modulePath);
        privateSession()?.revoke("signed-out");
      });
      await page.waitForURL("**/public-shell/session-ended.html?**");
      assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
      assert.equal(await page.evaluate((ref) => sessionStorage.getItem(`doctorcre-review:${ref}`), call.ref), null);
    }
    assert.equal(keys.length, 3);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
  } finally {
    await browser.close();
    await server.close();
  }
});
