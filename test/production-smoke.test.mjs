import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

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
  assert.doesNotMatch(config, /tests:\s*\[/, "the fixture config keeps the default tests/ discovery");
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
