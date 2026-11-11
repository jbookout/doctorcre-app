import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { CHROMIUM_SAFETY_ARGS } from "../scripts/chromium-safety-args.mjs";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "../scripts/proof-browser.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { detailFixture } from "./fixtures/tour-navigation/detail.ts";
import { assertProofDeadlineCleanup } from "./proof-browser-harness.mjs";

test("proof CLI passes approved evidence and fails a near-miss generated coordinate", async () => {
  const commit = "1".repeat(40),
    detail = detailFixture();
  const run = promisify(execFile);
  for (const broken of [false, true]) {
    const assets = await appAssetSnapshot();
    if (broken) {
      const asset = assets.get("/tours/vendor/tour-map-route-state.js");
      assert.ok(asset);
      const source = asset.body.toString();
      const brokenSource = source.replace(/destination=\$\{latitude\},\$\{longitude\}/, "destination=0,0");
      assert.notEqual(source, brokenSource);
      asset.body = Buffer.from(brokenSource);
    }
    const server = await startWorkerFixture({
      assets,
      env: {
        APP_ENV: "production",
        GIT_SHA: commit,
        CARR: {
          fetch: async (request) => {
            const path = new URL(request.url).pathname;
            return Response.json({
              csrf_token: "synthetic-proof-session",
              actor: { slug: "synthetic-user" },
              data:
                path === "/api/tours/detail"
                  ? detail
                  : path === "/api/tours/library"
                    ? { tours: [{ id: detail.id, name: detail.name }] }
                    : {},
            });
          },
        },
      },
    });
    try {
      const call = run(
        process.execPath,
        [
          "scripts/prove-tour-navigation.ts",
          "--fixture",
          "--origin",
          server.origin,
          "--commit",
          commit,
          "--tour",
          detail.id,
        ],
        { timeout: 60000 },
      );
      if (broken) await assert.rejects(call, (error) => error instanceof Error && "code" in error && error.code === 1);
      else assert.equal(JSON.parse((await call).stdout).status, "passed");
    } finally {
      await server.close();
    }
  }
});

test("itinerary Navigate exact coordinates hidden evidence and return at phone and desktop in both themes", async () => {
  let detail = detailFixture();
  let actor = "synthetic-user";
  const assets = await appAssetSnapshot();
  const server = await startWorkerFixture({
    assets,
    env: {
      CARR: {
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          const data =
            path === "/api/tours/library"
              ? { tours: [{ id: detail.id, name: detail.name }] }
              : path === "/api/tours/detail"
                ? detail
                : {};
          return Response.json({ data, csrf_token: "synthetic-navigation-session", actor: { slug: actor } });
        },
      },
    },
  });
  const browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    for (const width of [390, 1440])
      for (const theme of ["light", "dark"] as const) {
        detail = detailFixture();
        actor = "synthetic-user";
        const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
        await page.addInitScript(
          (value) => localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme: value })),
          theme,
        );
        await page.route(
          (url) => !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
          (route) => route.abort(),
        );
        await page.goto(`${server.origin}/tours/route-editor.html?tour=${detail.id}`);
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
        const root = page.locator("#accepted-itinerary");
        await root.locator("[data-itinerary-stop] button").nth(1).click();
        const navigate = root.getByRole("link", { name: "Navigate with Google Maps", exact: true });
        await navigate.waitFor();
        assert.equal(
          await navigate.getAttribute("href"),
          "https://www.google.com/maps/dir/?api=1&destination=30.422,-87.216&travelmode=driving",
        );
        assert.ok(await navigate.evaluate((el) => el.getBoundingClientRect().right <= innerWidth));
        await navigate.evaluate((el) => el.addEventListener("click", (event) => event.preventDefault()));
        await navigate.click();
        await page.reload();
        await navigate.waitFor();
        assert.equal(
          await root.locator("[aria-current=step]").getAttribute("data-itinerary-stop"),
          detail.stops[1]?.id,
        );
        if (process.env.TOUR_NAV_SHOTS) {
          await mkdir(process.env.TOUR_NAV_SHOTS, { recursive: true });
          await root.screenshot({ path: `${process.env.TOUR_NAV_SHOTS}/${width}-${theme}.png` });
        }
        actor = "another-synthetic-user";
        await page.reload();
        await navigate.waitFor();
        assert.equal(
          await root.locator("[aria-current=step]").getAttribute("data-itinerary-stop"),
          detail.stops[0]?.id,
        );
        await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
        assert.equal(await root.locator(".itinerary-navigation a").count(), 0);
        actor = "synthetic-user";
        detail = detailFixture();
        await page.reload();
        await navigate.waitFor();
        const replacement = detail.routes[0];
        assert.ok(replacement);
        replacement.id = "a3000000-0000-4000-8000-000000000002";
        replacement.route_version = 2;
        detail.route_version_id = replacement.id;
        detail.accepted_route_version = 2;
        await page.reload();
        await root.locator("[data-itinerary-stop]").first().waitFor();
        assert.equal(await root.locator(".itinerary-navigation a").count(), 0);
        assert.equal(
          await root.locator("[aria-current=step]").getAttribute("data-itinerary-stop"),
          detail.stops[0]?.id,
        );
        detail = detailFixture();
        const accepted = detail.routes[0];
        assert.ok(accepted);
        accepted.navigation.evidence.as_of = "2000-01-01T00:00:00Z";
        await page.reload();
        await root.locator("[data-itinerary-stop]").first().waitFor();
        assert.equal(await root.locator(".itinerary-navigation a").count(), 0);
        assert.equal(await root.locator("[data-itinerary-stop]").count(), 2);
        assert.equal(await root.locator("[data-itinerary-card]").count(), 1);
        await page.close();
      }
  } finally {
    await browser.close();
    await server.close();
  }
});

async function proofFixture(t: test.TestContext, commit: string) {
  const detail = detailFixture();
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: {
      APP_ENV: "production",
      GIT_SHA: commit,
      CARR: {
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          return Response.json({
            csrf_token: "synthetic-session",
            actor: { slug: "synthetic-user" },
            data:
              path === "/api/tours/detail"
                ? detail
                : path === "/api/tours/library"
                  ? { tours: [{ id: detail.id, name: detail.name }] }
                  : {},
          });
        },
      },
    },
  });
  t.after(() => server.close());
  return { args: ["--fixture", "--origin", server.origin, "--commit", commit, "--tour", detail.id] };
}

test("proof CLI accepts equal and descendant releases and refuses older unrelated and unknown releases", async (t) => {
  const cwd = temporaryDirectory("tour-proof-git-", t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.test", "commit", "--allow-empty", "-qm", "root");
  const older = git("rev-parse", "HEAD");
  git(
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "expected",
  );
  const expected = git("rev-parse", "HEAD");
  git(
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "descendant",
  );
  const descendant = git("rev-parse", "HEAD");
  git("checkout", "--orphan", "unrelated");
  git(
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "unrelated",
  );
  const unrelated = git("rev-parse", "HEAD");
  for (const [kind, observed] of Object.entries({
    equal: expected,
    descendant,
    older,
    unrelated,
    unknown: "f".repeat(40),
  })) {
    const { args } = await proofFixture(t, observed);
    args[args.indexOf("--commit") + 1] = expected;
    const execution = promisify(execFile)(
      process.execPath,
      [new URL("../scripts/prove-tour-navigation.ts", import.meta.url).pathname, ...args],
      { cwd, timeout: 60000 },
    );
    if (kind === "equal" || kind === "descendant") assert.equal(JSON.parse((await execution).stdout).status, "passed");
    else
      await assert.rejects(execution, (error: unknown) => {
        assert.ok(error && typeof error === "object" && "code" in error && "stdout" in error);
        assert.equal(error.code, 78, kind);
        assert.equal(JSON.parse(String(error.stdout)).status, "insufficient_evidence", kind);
        return true;
      });
  }
});

for (const mode of ["late launch", "stalled evaluation"] as const) {
  test(`Tour proof CLI deadline cleans ${mode}`, async (t) => {
    const { args } = await proofFixture(t, "1".repeat(40));
    await assertProofDeadlineCleanup(t, {
      entry: "scripts/prove-tour-navigation.ts",
      args,
      mode,
      timeoutMs: 1500,
      evaluationTarget: "locator",
    });
  });
}
