import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { chromium as rawChromium } from "playwright";
import { CHROMIUM_SAFETY_ARGS } from "../scripts/chromium-safety-args.mjs";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { prove } from "../scripts/prove-lead-opportunity-timing.ts";
import { chromium } from "./browser-harness.mjs";
import { cdpEndpoint } from "./cdp-fixture.ts";
import { timingFixture } from "./opportunity-timing-fixture.ts";

test("Retirement clears each timing view and fences late detail responses", async (t) => {
  const { server } = await setup(t);
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  for (const selection of ["board", "supported", "unknown"]) {
    await page.goto(`${server.origin}/leads`);
    await page.locator("[data-open]").first().waitFor();
    if (selection !== "board") {
      await page
        .locator("[data-open]")
        .nth(selection === "supported" ? 0 : 1)
        .click();
      await page.locator("#detailBody .lead-timing").waitFor();
    }
    await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
    assert.equal(await page.locator(".lead-timing").count(), 0);
  }
  await page.goto(`${server.origin}/leads`);
  await page.locator("[data-open]").first().waitFor();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requestStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  await page.route("**/mcp", async (route) => {
    if (route.request().postDataJSON()?.params?.arguments?.lead_id) {
      requestStarted();
      await gate;
    }
    await route.continue();
  });
  await page.locator("[data-open]").first().click();
  await started;
  await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
  const returned = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.request().postDataJSON()?.params?.arguments?.lead_id != null,
  );
  release();
  await returned;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.equal(await page.locator(".lead-timing").count(), 0);
  assert.equal(await page.locator("#detailBody").textContent(), "");
});

const appCommit = "1".repeat(40);
const producerCommit = "28ad26f601bdb4714331f122cd68337470509ef6";
const execute = promisify(execFile);
function runCli(origin: string, expectedCommit = appCommit, screenshots = false) {
  return execute(
    process.execPath,
    [
      "scripts/prove-lead-opportunity-timing.ts",
      "--fixture",
      "--origin",
      origin,
      "--producer-origin",
      origin,
      "--expected-commit",
      expectedCommit,
      ...(screenshots ? ["--screenshot-dir", "/tmp/WR591.S13.J6-shots"] : []),
    ],
    { timeout: 40000 },
  );
}
async function setup(t: { after(fn: () => unknown): void }, corrupt = false) {
  const fixture = timingFixture();
  const assets = await appAssetSnapshot();
  if (corrupt) {
    const asset = assets.get("/js/ui-lead-opportunity-timing.js");
    assert.ok(asset);
    const original = String(asset.body);
    const changed = original.replace("`Added ", "`Added 1");
    assert.notEqual(changed, original, "near-miss injection changed the compiled label");
    assets.set("/js/ui-lead-opportunity-timing.js", { ...asset, body: Buffer.from(changed) });
  }
  const server = await startWorkerFixture({
    assets,
    env: { APP_ENV: "staging", CARR: { fetch: fixture.fetch } },
    routes: new Map([
      [
        "/app-release",
        {
          contentType: "application/json",
          body: JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: appCommit }),
        },
      ],
      ["/release", { contentType: "application/json", body: JSON.stringify({ git_sha: producerCommit }) }],
    ]),
  });
  t.after(() => server.close());
  return { server, fixture };
}
test("Opportunity dates proof walks desktop and phone themes with keyboard paths", async (t) => {
  const { server } = await setup(t);
  const { stdout } = await runCli(server.origin, appCommit, true);
  assert.equal(JSON.parse(stdout).status, "passed");
});
test("Selected detail replaces revisions, withdraws and restores support, closes and retires", async (t) => {
  const { server, fixture } = await setup(t);
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: "Asia/Tokyo" });
  await page.goto(`${server.origin}/leads`);
  await page.locator("[data-open]").first().click();
  const panel = page.locator("#detailBody .lead-timing");
  await panel.waitFor();
  await panel.locator("summary").click();
  assert.equal(await panel.locator("dd").nth(4).textContent(), "Revision 1");
  fixture.revise();
  await page.evaluate(() => {
    document.getElementById("refreshBoard")?.click();
  });
  await page.getByText("Revision 2", { exact: true }).waitFor();
  assert.equal(await panel.locator("[data-timing-evidence] time").getAttribute("datetime"), "2026-10-02");
  fixture.withdraw();
  await page.evaluate(() => {
    document.getElementById("refreshBoard")?.click();
  });
  await panel.getByText("Opportunity timing unknown", { exact: true }).waitFor();
  assert.equal(await panel.locator("details").count(), 0);
  fixture.restore();
  await page.evaluate(() => {
    document.getElementById("refreshBoard")?.click();
  });
  await panel.locator("summary").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#leadDetail").waitFor({ state: "hidden" });
  await page.locator("[data-open]").nth(1).click();
  await panel.getByText("Opportunity timing unknown", { exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
  assert.equal(await page.locator(".lead-timing").count(), 0);
});
test("Proof fails on a near-miss date and refuses absent containing releases", async (t) => {
  const { server } = await setup(t);
  await assert.rejects(runCli(server.origin, "f".repeat(40)), { code: 78 });
  const { server: broken } = await setup(t, true);
  await assert.rejects(runCli(broken.origin), { code: 1 });
});

test("Proof deadline closes a late browser launch and a stalled evaluation", async (t) => {
  const { server } = await setup(t);
  for (const mode of ["late-launch", "stalled-evaluation"]) {
    let acquired: Awaited<ReturnType<typeof rawChromium.launch>> | undefined;
    let evaluated = false;
    let ownedPids: number[] = [];
    const engine = {
      async launch(options: Parameters<typeof rawChromium.launch>[0]) {
        acquired = await rawChromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options?.args || [])] });
        const session = await acquired.newBrowserCDPSession();
        try {
          ownedPids = (await session.send("SystemInfo.getProcessInfo")).processInfo.map((process) => process.id);
        } finally {
          await session.detach();
        }
        if (mode === "late-launch") await new Promise((resolve) => setTimeout(resolve, 1500));
        else {
          const newPage = acquired.newPage.bind(acquired);
          acquired.newPage = async (...args) => {
            const page = await newPage(...args);
            page.evaluate = () => {
              evaluated = true;
              return new Promise(() => {});
            };
            return page;
          };
        }
        return acquired;
      },
    };
    await assert.rejects(
      prove({
        origin: server.origin,
        producerOrigin: server.origin,
        expectedCommit: appCommit,
        fixture: true,
        timeoutMs: 1000,
        engine,
      }),
      { exitCode: 78 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.ok(acquired, "proof acquired the run-owned browser");
    assert.equal(acquired.isConnected(), false, mode);
    assert.ok(ownedPids.length > 0);
    for (const pid of ownedPids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    if (mode === "stalled-evaluation") assert.equal(evaluated, true);
  }
});

test("Late borrowed CDP page closes before disconnect and preserves existing tabs", async (t) => {
  const { server } = await setup(t);
  const browser = await rawChromium.launch({
    args: [...CHROMIUM_SAFETY_ARGS, "--remote-debugging-port=0", "--enable-automation"],
  });
  t.after(() => browser.close());
  const cdpUrl = await cdpEndpoint(browser);
  const connection = await rawChromium.connectOverCDP(cdpUrl);
  t.after(() => connection.close());
  const context = connection.contexts()[0];
  assert.ok(context);
  const existing = await context.newPage();
  await existing.goto("about:blank#existing");
  const newPage = context.newPage.bind(context);
  let acquired = 0;
  context.newPage = async () => {
    const page = await newPage();
    acquired++;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return page;
  };
  await assert.rejects(
    prove({
      origin: server.origin,
      producerOrigin: server.origin,
      expectedCommit: appCommit,
      expectedProducerCommit: producerCommit,
      cdpUrl,
      timeoutMs: 1000,
      engine: { launch: rawChromium.launch.bind(rawChromium), connectOverCDP: async () => connection },
    }),
    { exitCode: 78 },
  );
  assert.equal(acquired, 1);
  const fresh = await rawChromium.connectOverCDP(cdpUrl);
  try {
    const pages = fresh.contexts()[0]?.pages();
    assert.equal(pages?.length, 1);
    assert.equal(pages?.[0]?.url(), "about:blank#existing");
    assert.equal(browser.isConnected(), true);
  } finally {
    await fresh.close();
  }
});
