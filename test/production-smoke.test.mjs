import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { chromium } from "./browser-harness.mjs";
import { RELEASE_IDENTITY } from "../smoke/production/release-identity.mjs";

// The production journeys run against the live app after every release
// (carr-system ops/release-smoke.py). These guards keep them read-only and out
// of every other run.
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const journeys = async () => (await readdir(new URL("smoke/production/", root)))
  .filter((name) => name.endsWith(".e2e.ts")).sort();

test("production journeys exist and live outside the default test discovery", async () => {
  assert.ok((await journeys()).length >= 2, "at least two production journeys");
  const config = await read("e2e.config.ts");
  assert.doesNotMatch(config, /smoke\//, "the fixture config must never discover production journeys");
  for (const [, globs] of config.matchAll(/tests:\s*\[([^\]]*)\]/g)) {
    for (const [, glob] of globs.matchAll(/'([^']+)'/g)) assert.match(glob, /^tests\//, "the fixture config only discovers under tests/");
  }
});

test("the production config points at production, starts nothing and keeps evidence", async () => {
  const config = await read("e2e.production.config.ts");
  assert.match(config, /tests: \['smoke\/production\/\*\*\/\*\.e2e\.ts'\]/);
  assert.match(config, /process\.env\.DOCTORCRE_SMOKE_URL \?\? 'https:\/\/app\.doctorcre\.com'/);
  assert.doesNotMatch(config, /command:/, "a production run must never start a local server");
  assert.doesNotMatch(config, /agents:/, "a production run never calls a model");
  assert.match(config, /trace: 'on'/);
  assert.match(config, /E2E_TELEMETRY_DISABLED/);
});

test("every production journey is read-only and signed out", async () => {
  for (const name of await journeys()) {
    const source = await read(`smoke/production/${name}`);
    assert.doesNotMatch(source, /\bagent\b/, `${name} must not call a model`);
    assert.doesNotMatch(source, /\.(tap|fill|type|press|check|select|drag|clear)\(/,
      `${name} must not act on the page`);
    assert.doesNotMatch(source, /method:\s*['"](POST|PUT|PATCH|DELETE)/i, `${name} must only read`);
    assert.doesNotMatch(source, /auth\/login|cookie|session/i, `${name} must not start or carry a sign-in`);
    assert.match(source, /app\.screenshot\(/, `${name} keeps a screenshot as release evidence`);
  }
});

// The status journey's headline checks pass for any JSON /app-release, so the
// journey also requires the release identity. Serve the real /status page with
// valid and malformed releases and hold that check to both.
async function statusIdentity(t, release) {
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://localhost") return route.abort();
    if (url.pathname === "/app-release") return route.fulfill({ contentType: "application/json", body: JSON.stringify(release) });
    if (url.pathname === "/mcp" || url.pathname.startsWith("/api/")) return route.fulfill({ status: 401, body: "" });
    const path = url.pathname === "/status" ? "status.html" : url.pathname.slice(1);
    try {
      const contentType = /\.m?js$/.test(path) ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".json") ? "application/json" : "text/html";
      return route.fulfill({ body: await readFile(new URL(path, root)), contentType });
    } catch { return route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("http://localhost/status?mode=live");
  await page.waitForFunction(() => document.getElementById("statusHeadline").textContent !== "Updating…");
  const headline = await page.locator("#statusHeadline").textContent();
  assert.doesNotMatch(headline, /did not answer/, "the release answered, so the headline checks alone would pass");
  return page.locator("#statusIdentity").textContent();
}

test("the status journey requires a valid release identity, not just any answer", async (t) => {
  const journey = await read("smoke/production/status.e2e.ts");
  assert.match(journey, /locator\('#statusIdentity'\)\)\.toHaveText\(RELEASE_IDENTITY\)/);
  const commit = "0123456789abcdef0123456789abcdef01234567";
  await t.test("valid release", async (t) => {
    assert.match(await statusIdentity(t, { service: "doctorcre-app", environment: "production", source_commit: commit }), RELEASE_IDENTITY);
  });
  for (const [name, release] of [
    ["empty release", {}],
    ["missing source commit", { service: "doctorcre-app", environment: "production", source_commit: null }],
    ["non-string source commit", { service: "doctorcre-app", environment: "production", source_commit: 123 }],
    ["unset environment", { service: "doctorcre-app", environment: "unknown", source_commit: commit }],
  ]) await t.test(name, async (t) => {
    assert.doesNotMatch(await statusIdentity(t, release), RELEASE_IDENTITY);
  });
});
