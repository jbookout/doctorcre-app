import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { Ajv } from "ajv";
import { buildArtifact } from "../scripts/artifact.mjs";
import { startFixtureServer } from "../scripts/fixture-server.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { uiAssets } from "../scripts/ui-bundle.mjs";
import { parseWatch, type Watch } from "../src/ui/watches/model.ts";
import { chromium, componentDocument } from "./browser-harness.mjs";
import { subjectWatchV2ResponseSchema } from "./fixtures/watches/producer-schema.ts";

const recordedValue: unknown = JSON.parse(
  await readFile(new URL("./fixtures/watches/recorded.json", import.meta.url), "utf8"),
);

const recorded = {
  watch: parseWatch(recordedValue, { subject_type: "deal", subject_id: "3c8b7e16-50f8-40de-a757-bf9583df4dd2" }),
};
assert.ok(recorded.watch);
const originalWatch = recorded.watch;
const validateProducer = new Ajv({ strict: false, validateFormats: false }).compile(subjectWatchV2ResponseSchema);
const assets = await uiAssets((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8"));
test("built Deal Room and lease detail mount controls for the exact record", async (t) => {
  const directory = temporaryDirectory("watch-journey-", t);
  await buildArtifact({ root: new URL("../", import.meta.url).pathname, outDir: directory, commit: "1".repeat(40) });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: `${directory}/site` } });
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const kind of ["deal", "lease"] as const) {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    try {
      await page.route("**/mcp", (route) => {
        if (route.request().postDataJSON().params.name === "list-subject-watches-v2") {
          const payload = {
            ok: true,
            schema_version: "subject-watch.v2",
            watches: [
              { ...originalWatch, subject_type: kind, baseline: { ...originalWatch.baseline, subject_type: kind } },
            ],
            has_more: false,
            next_cursor: null,
          };
          assert.equal(validateProducer(payload), true);
          return route.fulfill({ json: { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } } });
        }
        const args: unknown = route.request().postDataJSON().params.arguments;
        assert.ok(typeof args === "object" && args !== null && "subject_id" in args && "subject_type" in args);
        assert.equal(args.subject_id, originalWatch.subject_id);
        assert.equal(args.subject_type, kind);
        const sample = {
          ...originalWatch,
          subject_type: kind,
          baseline: { ...originalWatch.baseline, subject_type: kind },
        };
        const payload = { ok: true, schema_version: "subject-watch.v2", watch: sample };
        assert.equal(validateProducer(payload), true);
        parseWatch(payload, { subject_type: kind, subject_id: originalWatch.subject_id });
        return route.fulfill({ json: { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } } });
      });
      if (kind === "deal") {
        const fixture = (
          await readFile(new URL("../data/fixtures/fact-review.mjs", import.meta.url), "utf8")
        ).replaceAll("'d14'", JSON.stringify(originalWatch.subject_id));
        const seed = (await readFile(new URL("../data/board-seed.json", import.meta.url), "utf8")).replaceAll(
          '"d14"',
          JSON.stringify(originalWatch.subject_id),
        );
        await page.route("**/data/fixtures/fact-review.mjs", (route) =>
          route.fulfill({ body: fixture, contentType: "text/javascript" }),
        );
        await page.route("**/data/board-seed.json", (route) =>
          route.fulfill({ body: seed, contentType: "application/json" }),
        );
        await page.goto(`${server.url}/deals?deal=${originalWatch.subject_id}`);
      } else {
        const fixture = (await readFile(new URL("../js/lease-radar-fixture.js", import.meta.url), "utf8"))
          .replace(
            `id:\`demo-lease-\${i}\``,
            `id:i===1?${JSON.stringify(originalWatch.subject_id)}:\`demo-lease-\${i}\``,
          )
          .replace(
            `client_name:\`Demo Practice \${i}\``,
            `client_name:i===1 && globalThis.watchRefreshName ? globalThis.watchRefreshName : \`Demo Practice \${i}\``,
          );
        await page.route("**/js/lease-radar-fixture.js", (route) =>
          route.fulfill({ body: fixture, contentType: "text/javascript" }),
        );
        await page.goto(`${server.url}/leases?lease=${originalWatch.subject_id}`);
      }
      await page.locator("summary").filter({ hasText: "watch settings" }).click();
      const panel = page.getByRole("region", { name: kind === "deal" ? "Deal watch" : "Lease watch", exact: true });
      await panel.getByRole("heading", { name: "Watching", exact: true }).waitFor();
      await panel.getByRole("button", { name: "Pause watch", exact: true }).waitFor();
      for (const row of await panel.locator(".watch-option").evaluateAll((nodes) =>
        nodes.map((node) => {
          const input = node.querySelector("input");
          return { rowHeight: node.getBoundingClientRect().height, glyphWidth: input?.getBoundingClientRect().width };
        }),
      )) {
        assert.ok(row.rowHeight >= 44);
        assert.equal(row.glyphWidth, 16);
      }
      assert.equal(
        await panel.locator(".watch-primary").evaluate((node) => getComputedStyle(node).backgroundColor),
        await panel.evaluate((node) => {
          const probe = document.createElement("span");
          probe.style.backgroundColor = "var(--accent)";
          node.append(probe);
          const color = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return color;
        }),
      );
      const evidence = new URL("../out/test-artifacts/watches/", import.meta.url);
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: new URL(`${kind}.png`, evidence).pathname });
      if (kind === "lease") {
        const pause = panel.getByRole("button", { name: "Pause watch", exact: true });
        await pause.focus();
        const reread = page.waitForResponse(
          (response) =>
            response.url().endsWith("/mcp") &&
            response.request().postDataJSON().params.name === "list-subject-watches-v2",
        );
        await page.evaluate(() => {
          Reflect.set(window, "watchRefreshName", "Demo Practice 1 updated");
          window.dispatchEvent(new Event("online"));
        });
        await reread;
        assert.equal(await page.locator("#leaseDetail h2").textContent(), "Demo Practice 1 updated");
        assert.equal(
          await pause.evaluate((node) => node === document.activeElement),
          true,
          "Radar refresh retains focused watch action",
        );
        await page.getByRole("button", { name: "Close lease details" }).click();
        await page.locator("[data-radar-watch]").filter({ hasText: "Lease watching" }).waitFor();
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await page.screenshot({ path: new URL(`radar-${width}.png`, evidence).pathname, animations: "disabled" });
          await page.evaluate(() => {
            document.documentElement.dataset.theme = "light";
          });
          await page.screenshot({
            path: new URL(`radar-${width}-light.png`, evidence).pathname,
            animations: "disabled",
          });
          await page.evaluate(() => {
            document.documentElement.dataset.theme = "dark";
          });
        }
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally {
      await page.context().close();
    }
  }
});
async function mountedWatch(t: TestContext, kind: "deal" | "lease", subjectId = originalWatch.subject_id) {
  const subject = { subject_type: kind, subject_id: subjectId };
  const sample = {
    ...originalWatch,
    subject_type: kind,
    baseline: { ...originalWatch.baseline, subject_type: kind },
  };
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: kind === "deal" ? 390 : 1440, height: 900 } });
  await componentDocument(page, "http://localhost:43210", {
    headers: { "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" },
    html: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="host"></div>',
    dispose: (page) =>
      page.evaluate(() => {
        const control: unknown = Reflect.get(window, "control");
        if (
          typeof control === "object" &&
          control !== null &&
          "dispose" in control &&
          typeof control.dispose === "function"
        )
          control.dispose();
      }),
  });
  await page.route("**/*.js", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    const body = assets.get(path) ?? (await readFile(new URL(`../${path}`, import.meta.url)));
    await route.fulfill({ body, contentType: "text/javascript" });
  });
  await page.route("**/*.mjs", async (route) =>
    route.fulfill({
      body: await readFile(new URL(`../${new URL(route.request().url()).pathname.slice(1)}`, import.meta.url)),
      contentType: "text/javascript",
    }),
  );
  const queuedReads: Watch[] = [];
  const readReleases: (() => Promise<void>)[] = [];
  let current: Watch | null = null;
  let mode = "ok";
  let release: () => Promise<void> = async () => {
    throw Error("Response not held");
  };
  let notifyHeld = () => {};
  const waitHeld = () =>
    new Promise<void>((resolve) => {
      notifyHeld = resolve;
    });
  const requests: { name: string; args: object }[] = [];
  const response = (watch: Watch | null) => {
    const result = { ok: true, schema_version: "subject-watch.v2", watch };
    assert.equal(validateProducer(result), true);
    parseWatch(result, subject);
    return result;
  };
  await page.route("**/mcp", async (route) => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    requests.push({ name, args });
    const finish = (payload: unknown) =>
      route.fulfill({
        json: { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify(payload) }] } },
      });
    if (name === "read-subject-watch-v2") {
      if (mode === "held-read") {
        const snapshot = response(queuedReads.shift() ?? current);
        release = () => finish(snapshot);
        readReleases.push(release);
        notifyHeld();
        return;
      }
      return finish(mode === "malformed" ? { ok: true, watch: {} } : response(current));
    }
    if (name !== "watch-subject-v2") assert.ok(current);
    if (mode === "conflict") {
      mode = "ok";
      current = {
        ...(current ?? originalWatch),
        lifecycle_version: (current ?? originalWatch).lifecycle_version + 1,
        policy: { ...originalWatch.policy, lease_threshold_days: [7] },
      };
      return finish({ error: "watch_stale_version" });
    }
    if (name === "watch-subject-v2") current = { ...sample, policy: args.policy };
    if (name === "pause-subject-watch-v2")
      current = { ...(current ?? originalWatch), state: "paused", lifecycle_version: 2 };
    if (name === "resume-subject-watch-v2")
      current = { ...(current ?? originalWatch), state: "watching", lifecycle_version: 3 };
    if (name === "replace-subject-watch-policy-v2")
      current = {
        ...(current ?? originalWatch),
        policy: args.policy,
        lifecycle_version: (current ?? originalWatch).lifecycle_version + 1,
      };
    if (name === "unwatch-subject-v2")
      current = {
        ...(current ?? originalWatch),
        state: "removed",
        lifecycle_version: (current ?? originalWatch).lifecycle_version + 1,
      };
    if (mode === "lost") {
      mode = "ok";
      return route.abort();
    }
    if (mode === "slow") {
      release = () => finish(response(current));
      notifyHeld();
      return;
    }
    return finish(response(current));
  });
  await page.evaluate(async (subject) => {
    const { mountWatchControl } = await import(String("/js/ui-watches.generated.js"));
    const host = document.getElementById("host");
    if (!host) throw Error("Host missing");
    Object.assign(window, { control: mountWatchControl(host, { subject }) });
  }, subject);
  return {
    page,
    sample,
    requests,
    waitHeld,
    release: () => release(),
    queueRead: (value: Watch) => queuedReads.push(value),
    releaseRead: (index: number) => {
      const callback = readReleases[index];
      if (!callback) throw Error("Read not held");
      return callback();
    },
    setMode: (value: string) => {
      mode = value;
    },
    setCurrent: (value: Watch | null) => {
      current = value;
    },
  };
}
for (const kind of ["deal", "lease"] as const)
  test(`${kind} recorded watch journey confirms, retries, reconciles and retires`, async (t) => {
    const fixture = await mountedWatch(t, kind);
    const { page, requests, waitHeld, release } = fixture;
    await page.locator("summary").filter({ hasText: "watch settings" }).click();
    await page.getByRole("heading", { name: "Not watching", exact: true }).waitFor();
    fixture.setMode("slow");
    const held = waitHeld();
    await page.getByRole("button", { name: "Start watch", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByText("Saving watch.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Watching", exact: true }).count(), 0);
    await held;
    fixture.setMode("ok");
    await release();
    await page.getByRole("heading", { name: "Watching", exact: true }).waitFor();
    const startPolicy = Reflect.get(Object(requests.find((row) => row.name === "watch-subject-v2")?.args), "policy");
    assert.deepEqual(startPolicy, {
      change_kinds: kind === "deal" ? ["reply_arrived"] : ["lease_threshold_crossed"],
      include_self_changes: true,
      ...(kind === "lease" ? { lease_threshold_days: [30, 90] } : {}),
    });
    fixture.setMode("lost");
    await page.getByRole("button", { name: "Pause watch", exact: true }).click();
    await page.getByRole("button", { name: "Retry same watch request" }).waitFor();
    const original = requests.at(-1);
    await page.getByRole("button", { name: "Retry same watch request" }).click();
    await page.getByRole("heading", { name: "Watch paused", exact: true }).waitFor();
    assert.deepEqual(requests.filter((row) => row.name === "pause-subject-watch-v2").at(-1), original);
    await page.getByRole("button", { name: "Resume watch", exact: true }).click();
    await page.getByRole("heading", { name: "Watching", exact: true }).waitFor();
    await page.getByLabel("Lease date reminders", { exact: true }).check();
    await page.getByLabel("Lease threshold days").fill("12, 45");
    fixture.setMode("conflict");
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByText(/This watch changed/).waitFor();
    assert.equal(await page.getByLabel("Lease threshold days").inputValue(), "12, 45");
    assert.match((await page.getByLabel("Confirmed watch policy").textContent()) ?? "", /7 days before the lease date/);
    await page.getByRole("button", { name: "Save settings" }).click();
    await page
      .getByLabel("Confirmed watch policy")
      .getByText(/12, 45 days before the lease date/)
      .waitFor();
    fixture.setMode("malformed");
    await page.getByRole("button", { name: "Refresh watch" }).click();
    await page.getByText(/Watch state unavailable/).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Not watching", exact: true }).count(), 0);
    fixture.setMode("ok");
    await page.getByRole("button", { name: "Refresh watch" }).click();
    await page.getByRole("button", { name: "Remove watch" }).click();
    await page.getByRole("heading", { name: "Not watching", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    fixture.setMode("slow");
    const lateHeld = waitHeld();
    await page.getByRole("button", { name: "Start watch", exact: true }).click();
    await page.getByText("Saving watch.", { exact: true }).waitFor();
    await lateHeld;
    await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
    await page.getByText("Sign in again to inspect this watch.", { exact: true }).waitFor();
    await release().catch(() => {});
    assert.equal(await page.getByRole("button").count(), 0);
  });

for (const kind of ["deal", "lease"] as const)
  test(`${kind} rejects regressing lifecycle reads and accepts a new generation`, async (t) => {
    const f = await mountedWatch(t, kind);
    await f.page.locator("summary").click();
    await f.page.getByRole("heading", { name: "Not watching", exact: true }).waitFor();
    f.setCurrent({ ...f.sample, lifecycle_version: 4 });
    await f.page.getByRole("button", { name: "Refresh watch" }).click();
    await f.page.getByText(/Last confirmed version 4/).waitFor();
    f.setCurrent({ ...f.sample, state: "paused", lifecycle_version: 2 });
    await f.page.getByRole("button", { name: "Refresh watch" }).click();
    await f.page.getByRole("status").getByText(/stale/i).waitFor();
    assert.equal(await f.page.getByRole("button", { name: "Pause watch", exact: true }).isDisabled(), true);
    assert.equal(await f.page.getByRole("heading", { name: "Watch paused", exact: true }).count(), 0);
    await f.page.getByText(/Last confirmed version 4/).waitFor();
    f.setCurrent({ ...f.sample, lifecycle_version: 4 });
    await f.page.getByRole("button", { name: "Refresh watch" }).click();
    await f.page.getByRole("button", { name: "Pause watch", exact: true }).click();
    await f.page.getByRole("status").getByText(/stale/i).waitFor();
    f.setCurrent({ ...f.sample, id: "a981397b-4a90-45ce-bbe5-654509d53b4a", state: "paused", lifecycle_version: 1 });
    await f.page.getByRole("button", { name: "Refresh watch" }).click();
    await f.page.getByRole("heading", { name: "Watch paused", exact: true }).waitFor();
    assert.equal(await f.page.getByRole("button", { name: "Resume watch", exact: true }).isDisabled(), false);
  });

test("collapsed watch settings do not read until opened", async (t) => {
  const f = await mountedWatch(t, "deal");
  await f.page.locator("summary").waitFor();
  await f.page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  assert.equal(f.requests.length, 0);
  await f.page.locator("summary").click();
  await f.page.getByRole("heading", { name: "Not watching", exact: true }).waitFor();
  assert.equal(f.requests.length, 1);
});

for (const kind of ["deal", "lease"] as const)
  for (const phase of ["Loading", "Ready", "Unavailable", "Uncertain"] as const)
    test(`${kind} sign-out from ${phase} removes confirmation and ignores late callbacks`, async (t) => {
      const f = await mountedWatch(t, kind);
      f.setCurrent(f.sample);
      await f.page.locator("summary").click();
      await f.page.getByRole("heading", { name: "Watching", exact: true }).waitFor();
      let late = false;
      if (phase === "Loading") {
        f.setMode("held-read");
        const held = f.waitHeld();
        await f.page.getByRole("button", { name: "Refresh watch" }).click();
        await held;
        late = true;
      } else if (phase === "Unavailable") {
        f.setMode("malformed");
        await f.page.getByRole("button", { name: "Refresh watch" }).click();
        await f.page.getByText(/Watch state unavailable/).waitFor();
      } else if (phase === "Uncertain") {
        f.setMode("lost");
        await f.page.getByRole("button", { name: "Pause watch", exact: true }).click();
        await f.page.getByText(/Outcome unknown/).waitFor();
      }
      await f.page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
      await f.page.getByText(/Sign in again/).waitFor();
      assert.equal(await f.page.getByLabel("Confirmed watch policy").count(), 0);
      assert.equal(await f.page.getByRole("button").count(), 0);
      if (late) await f.release().catch(() => {});
      await f.page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      assert.equal(await f.page.getByLabel("Confirmed watch policy").count(), 0);
      assert.equal(await f.page.getByRole("button").count(), 0);
      assert.equal(await f.page.getByRole("heading", { name: "Watching", exact: true }).count(), 0);
    });

test("out-of-order reads ignore the superseded callback", async (t) => {
  const f = await mountedWatch(t, "deal");
  await f.page.locator("summary").click();
  await f.page.getByRole("heading", { name: "Not watching", exact: true }).waitFor();
  f.queueRead({ ...f.sample, id: "a981397b-4a90-45ce-bbe5-654509d53b4a", state: "paused", lifecycle_version: 9 });
  f.queueRead({ ...f.sample, lifecycle_version: 4 });
  f.setMode("held-read");
  await f.page.getByRole("button", { name: "Refresh watch" }).evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await f.page
    .getByRole("status")
    .getByText(/Reading/)
    .waitFor();
  await f.page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await f.releaseRead(1);
  await f.page.getByText(/Last confirmed version 4/).waitFor();
  await f.releaseRead(0);
  await f.page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  assert.equal(f.requests.filter((row) => row.name === "read-subject-watch-v2").length, 3);
  assert.equal(await f.page.getByRole("heading", { name: "Watch paused", exact: true }).count(), 0);
  assert.equal(await f.page.getByRole("button", { name: "Pause watch", exact: true }).isDisabled(), false);
  await f.page.getByText(/Last confirmed version 4/).waitFor();
});

test("fixture-only record identities do not expose server watch controls", async (t) => {
  const f = await mountedWatch(t, "lease", "demo-lease-1");
  await f.page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  assert.equal(await f.page.locator("summary").count(), 0);
  assert.equal(f.requests.length, 0);
});

test("radar confirms complete lists, preserves focus, fails closed and fences sign-out", async (t) => {
  const { page } = await mountedWatch(t, "lease");
  await page.evaluate(async (subject) => {
    const { mountRadarWatches } = await import(String("/js/ui-watches.generated.js"));
    const host = document.createElement("section");
    host.id = "radar";
    const button = document.createElement("button");
    button.textContent = "Open exact lease";
    const status = document.createElement("small");
    status.dataset.radarWatch = subject;
    button.append(status);
    host.append(button);
    document.body.append(host);
    button.focus();
    Object.assign(window, { radar: mountRadarWatches(host) });
    Reflect.get(window, "radar").paint([{ id: subject, deal_id: null }]);
  }, originalWatch.subject_id);
  let mode = "ok";
  let finish = async () => {};
  await page.route("**/mcp", async (route) => {
    const payload =
      mode === "bad"
        ? {}
        : { ok: true, schema_version: "subject-watch.v2", watches: [], has_more: false, next_cursor: null };
    if (mode === "ok") assert.equal(validateProducer(payload), true);
    const fulfill = () =>
      route.fulfill({ json: { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } } });
    if (mode === "hold") {
      finish = fulfill;
      return;
    }
    await fulfill();
  });
  const refresh = () =>
    page.evaluate(() => {
      void Reflect.get(window, "radar").refresh();
    });
  await refresh();
  await page.getByText("Lease not watching", { exact: true }).waitFor();
  assert.equal(await page.locator("#radar button").evaluate((n) => n === document.activeElement), true);
  mode = "bad";
  await refresh();
  await page.getByText("Watch states unavailable", { exact: true }).waitFor();
  mode = "ok";
  await refresh();
  await page.getByText("Lease not watching", { exact: true }).waitFor();
  mode = "hold";
  await refresh();
  await page.getByText("Reading watch states…", { exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
  await page.getByText("Sign in to inspect watches", { exact: true }).waitFor();
  await finish();
  await refresh();
  assert.equal(await page.locator("[data-radar-watch]").textContent(), "Sign in to inspect watches");
  await page.evaluate(() => Reflect.get(window, "radar").dispose());
});

for (const phase of ["Confirmed", "Unavailable"] as const)
  test(`radar sign-out from ${phase} hides confirmations and refuses refresh`, async (t) => {
    const { page } = await mountedWatch(t, "lease");
    await page.evaluate(
      async ({ id, phase }) => {
        const { mountRadarWatches } = await import(String("/js/ui-watches.generated.js"));
        const host = document.createElement("section");
        const status = document.createElement("small");
        status.dataset.radarWatch = id;
        host.append(status);
        document.body.append(host);
        let calls = 0;
        const radar = mountRadarWatches(host, async () => {
          calls++;
          if (phase === "Unavailable") throw Error("Read failed");
          return [];
        });
        radar.paint([{ id, deal_id: null }]);
        await radar.refresh();
        if (status.textContent !== (phase === "Confirmed" ? "Lease not watching" : "Watch states unavailable"))
          throw Error("Wrong starting phase");
        window.dispatchEvent(new Event("doctorcre-session-invalidated"));
        await radar.refresh();
        if (String(status.textContent) !== "Sign in to inspect watches" || calls !== 1)
          throw Error("Session retirement failed");
        radar.dispose();
      },
      { id: originalWatch.subject_id, phase },
    );
  });

test("radar rejects a regressing lifecycle version and permits a new generation", async (t) => {
  const { page, sample } = await mountedWatch(t, "lease");
  await page.evaluate(async (sample) => {
    const { mountRadarWatches } = await import(String("/js/ui-watches.generated.js"));
    const host = document.createElement("section");
    const status = document.createElement("small");
    status.dataset.radarWatch = sample.subject_id;
    host.append(status);
    document.body.append(host);
    let current = { ...sample, lifecycle_version: 4 };
    const radar = mountRadarWatches(host, async () => [current]);
    radar.paint([{ id: sample.subject_id, deal_id: null }]);
    await radar.refresh();
    if (!status.textContent?.startsWith("Lease watching")) throw Error("No initial confirmation");
    current = { ...sample, lifecycle_version: 2, state: "paused" };
    await radar.refresh();
    if (status.textContent !== "Watch states unavailable") throw Error("Stale list was accepted");
    current = { ...sample, id: "a593ce5f-a245-432b-a829-329a7a461a34", lifecycle_version: 1 };
    await radar.refresh();
    if (!status.textContent?.startsWith("Lease watching")) throw Error("New generation refused");
    radar.dispose();
  }, sample);
});

test("radar superseded list cannot replace a newer confirmation", async (t) => {
  const { page, sample } = await mountedWatch(t, "lease");
  await page.evaluate(async (sample) => {
    const { mountRadarWatches } = await import(String("/js/ui-watches.generated.js"));
    const host = document.createElement("section");
    const status = document.createElement("small");
    status.dataset.radarWatch = sample.subject_id;
    host.append(status);
    document.body.append(host);
    const releases: ((value: (typeof sample)[]) => void)[] = [];
    const radar = mountRadarWatches(host, () => new Promise<(typeof sample)[]>((resolve) => releases.push(resolve)));
    radar.paint([{ id: sample.subject_id, deal_id: null }]);
    const first = radar.refresh();
    const second = radar.refresh();
    const newer = releases[1];
    const older = releases[0];
    if (!newer || !older) throw Error("Reads not held");
    newer([]);
    await second;
    older([sample]);
    await first;
    if (status.textContent !== "Lease not watching") throw Error("Late read replaced new confirmation");
    radar.dispose();
  }, sample);
});

for (const kind of ["deal", "lease"] as const)
  for (const thresholds of [
    { lease_threshold_days: [90, 0, 3650] },
    { lease_threshold_months: [24, 12, 6] },
    { lease_threshold_days: [90, 0], lease_threshold_months: [24, 6] },
  ])
    test(`${kind} canonical threshold units survive open refresh and self-change save ${JSON.stringify(thresholds)}`, async (t) => {
      const f = await mountedWatch(t, kind);
      const policy = { change_kinds: ["lease_threshold_crossed"] as const, include_self_changes: true, ...thresholds };
      f.setCurrent({ ...f.sample, policy: { ...policy, change_kinds: [...policy.change_kinds] } });
      await f.page.locator("summary").click();
      await f.page.getByRole("heading", { name: "Watching", exact: true }).waitFor({ timeout: 5000 });
      const days = "lease_threshold_days" in thresholds ? thresholds.lease_threshold_days : undefined;
      const months = "lease_threshold_months" in thresholds ? thresholds.lease_threshold_months : undefined;
      assert.equal(
        await f.page.getByLabel("Lease threshold days", { exact: true }).inputValue(),
        days?.join(", ") ?? "",
      );
      assert.equal(await f.page.getByLabel("Lease threshold calendar months").inputValue(), months?.join(", ") ?? "");
      const labels = [
        days ? ` · ${days.join(", ")} days before the lease date` : "",
        months ? ` · ${months.join(", ")} calendar months before the lease date` : "",
      ].join("");
      assert.equal(
        await f.page.getByLabel("Confirmed watch policy").locator("p").nth(1).textContent(),
        `Lease date reminders${labels}`,
      );
      if (months && !days) {
        const evidence = new URL("../out/test-artifacts/watches/", import.meta.url);
        await mkdir(evidence, { recursive: true });
        await f.page.screenshot({ path: new URL(`months-${kind}.png`, evidence).pathname });
      }
      await f.page.getByRole("button", { name: "Refresh watch" }).click();
      await f.page.getByRole("button", { name: "Save settings" }).waitFor({ state: "visible" });
      await f.page.getByLabel("Include changes I make").uncheck();
      await f.page.getByRole("button", { name: "Save settings" }).click();
      await f.page.getByText(/Excludes my changes/).waitFor();
      assert.deepEqual(
        Reflect.get(Object(f.requests.find((row) => row.name === "replace-subject-watch-policy-v2")?.args), "policy"),
        { ...policy, include_self_changes: false },
      );
      assert.equal(f.requests.filter((row) => row.name !== "read-subject-watch-v2").length, 1);
    });

test("month policy edits validate both units and preserve frozen retries and conflicted drafts", async (t) => {
  const f = await mountedWatch(t, "lease");
  f.setCurrent({
    ...f.sample,
    policy: { change_kinds: ["lease_threshold_crossed"], include_self_changes: true, lease_threshold_months: [24, 6] },
  });
  await f.page.locator("summary").click();
  await f.page.getByRole("heading", { name: "Watching", exact: true }).waitFor();
  const days = f.page.getByLabel("Lease threshold days", { exact: true });
  const months = f.page.getByLabel("Lease threshold calendar months");
  for (const [input, values] of [
    [days, ["-1", "3651", "1.5", "2,2", "1,", Array.from({ length: 21 }, (_, i) => i).join(",")]],
    [months, ["-1", "121", "1.5", "2,2", "1,", Array.from({ length: 21 }, (_, i) => i).join(",")]],
  ] as const) {
    for (const value of values) {
      await input.fill(value);
      await f.page.getByRole("button", { name: "Save settings" }).click();
      await f.page
        .getByRole("status")
        .getByText(/Choose a change category/)
        .waitFor();
      assert.equal(f.requests.filter((row) => row.name !== "read-subject-watch-v2").length, 0);
    }
    await input.fill(input === days ? "" : "24, 6");
  }
  await months.fill("");
  await f.page.getByRole("button", { name: "Save settings" }).click();
  assert.equal(f.requests.filter((row) => row.name !== "read-subject-watch-v2").length, 0);
  await days.fill("3650, 0");
  await months.fill("120, 0");
  f.setMode("lost");
  await f.page.getByRole("button", { name: "Save settings" }).click();
  await f.page.getByRole("button", { name: "Retry same watch request" }).waitFor();
  const pending = f.requests.at(-1);
  assert.equal(await months.isDisabled(), true);
  await f.page.getByRole("button", { name: "Retry same watch request" }).click();
  await f.page.getByRole("button", { name: "Save settings" }).waitFor();
  await f.page.getByText(/Last confirmed version 3/).waitFor();
  assert.deepEqual(f.requests.filter((row) => row.name === "replace-subject-watch-policy-v2").at(-1), pending);
  await days.fill("");
  f.setMode("conflict");
  await f.page.getByRole("button", { name: "Save settings" }).click();
  await f.page.getByText(/This watch changed/).waitFor();
  assert.equal(await days.inputValue(), "");
  assert.equal(await months.inputValue(), "120, 0");
  await f.page.getByRole("button", { name: "Save settings" }).click();
  await f.page.getByText(/Last confirmed version 5/).waitFor();
  const monthPolicy = Reflect.get(
    Object(f.requests.filter((row) => row.name === "replace-subject-watch-policy-v2").at(-1)?.args),
    "policy",
  );
  assert.deepEqual(monthPolicy, {
    change_kinds: ["lease_threshold_crossed"],
    include_self_changes: true,
    lease_threshold_months: [120, 0],
  });
  await days.fill("90");
  await months.fill("");
  await f.page.getByRole("button", { name: "Save settings" }).click();
  await f.page.getByText(/Last confirmed version 6/).waitFor();
  assert.deepEqual(
    Reflect.get(
      Object(f.requests.filter((row) => row.name === "replace-subject-watch-policy-v2").at(-1)?.args),
      "policy",
    ),
    { change_kinds: ["lease_threshold_crossed"], include_self_changes: true, lease_threshold_days: [90] },
  );
});

test("month-bearing late read is discarded after session invalidation", async (t) => {
  const f = await mountedWatch(t, "lease");
  await f.page.locator("summary").click();
  await f.page.getByRole("heading", { name: "Not watching", exact: true }).waitFor();
  f.setCurrent({
    ...f.sample,
    policy: { change_kinds: ["lease_threshold_crossed"], include_self_changes: true, lease_threshold_months: [24, 6] },
  });
  f.setMode("held-read");
  const held = f.waitHeld();
  await f.page.getByRole("button", { name: "Refresh watch" }).click();
  await held;
  await f.page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
  await f.release().catch(() => {});
  await f.page.getByText(/Sign in again/).waitFor();
  assert.equal(await f.page.getByRole("button").count(), 0);
  assert.equal(await f.page.getByLabel("Confirmed watch policy").count(), 0);
});
