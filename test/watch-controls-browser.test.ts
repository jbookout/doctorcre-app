import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
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
        const fixture = (await readFile(new URL("../js/lease-radar-fixture.js", import.meta.url), "utf8")).replace(
          `id:\`demo-lease-\${i}\``,
          `id:i===1?${JSON.stringify(originalWatch.subject_id)}:\`demo-lease-\${i}\``,
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
      const evidence = new URL("../out/test-artifacts/watches/", import.meta.url);
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: new URL(`${kind}.png`, evidence).pathname });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally {
      await page.context().close();
    }
  }
});
for (const kind of ["deal", "lease"] as const)
  test(`${kind} recorded watch journey confirms, retries, reconciles and retires`, async (t) => {
    const subject = { subject_type: kind, subject_id: originalWatch.subject_id };
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
      if (name === "read-subject-watch-v2")
        return finish(mode === "malformed" ? { ok: true, watch: {} } : response(current));
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
      const { mountWatchControl } = await import(String("/js/ui-watches.js"));
      const host = document.getElementById("host");
      if (!host) throw Error("Host missing");
      Object.assign(window, { control: mountWatchControl(host, { subject }) });
    }, subject);
    await page.locator("summary").filter({ hasText: "watch settings" }).click();
    await page.getByRole("heading", { name: "Not watching", exact: true }).waitFor();
    mode = "slow";
    const held = waitHeld();
    await page.getByRole("button", { name: "Start watch", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByText("Waiting for CARR to confirm.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Watching", exact: true }).count(), 0);
    await held;
    mode = "ok";
    await release();
    await page.getByRole("heading", { name: "Watching", exact: true }).waitFor();
    mode = "lost";
    await page.getByRole("button", { name: "Pause watch", exact: true }).click();
    await page.getByRole("button", { name: "Retry same watch request" }).waitFor();
    const original = requests.at(-1);
    await page.getByRole("button", { name: "Retry same watch request" }).click();
    await page.getByRole("heading", { name: "Watch paused", exact: true }).waitFor();
    assert.deepEqual(requests.filter((row) => row.name === "pause-subject-watch-v2").at(-1), original);
    await page.getByRole("button", { name: "Resume watch", exact: true }).click();
    await page.getByRole("heading", { name: "Watching", exact: true }).waitFor();
    await page.getByLabel("Lease thresholds", { exact: true }).check();
    await page.getByLabel("Lease threshold days").fill("12, 45");
    mode = "conflict";
    await page.getByRole("button", { name: "Save watch policy" }).click();
    await page.getByText(/This watch changed/).waitFor();
    assert.equal(await page.getByLabel("Lease threshold days").inputValue(), "12, 45");
    assert.match((await page.getByLabel("Confirmed watch policy").textContent()) ?? "", /7 days/);
    await page.getByRole("button", { name: "Save watch policy" }).click();
    await page
      .getByLabel("Confirmed watch policy")
      .getByText(/12, 45 days/)
      .waitFor();
    mode = "malformed";
    await page.getByRole("button", { name: "Refresh watch" }).click();
    await page.getByText(/Watch state unavailable/).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Not watching", exact: true }).count(), 0);
    mode = "ok";
    await page.getByRole("button", { name: "Refresh watch" }).click();
    await page.getByRole("button", { name: "Remove watch" }).click();
    await page.getByRole("heading", { name: "Not watching", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    mode = "slow";
    const lateHeld = waitHeld();
    await page.getByRole("button", { name: "Start watch", exact: true }).click();
    await page.getByText("Waiting for CARR to confirm.", { exact: true }).waitFor();
    await lateHeld;
    await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
    await page.getByText("Sign in again to inspect this watch.", { exact: true }).waitFor();
    await release().catch(() => {});
    assert.equal(await page.getByRole("button").count(), 0);
  });
