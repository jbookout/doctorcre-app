import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

test("production can reach CARR without making the app publicly routable", () => {
  assert.equal(config.name, "doctorcre-app");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, true);
  assert.deepEqual(config.routes, []);
  assert.deepEqual(config.services, [{ binding: "CARR", service: "carr-mcp" }]);
  assert.equal(config.vars.APP_ENV, "production");
});

test("staging remains isolated from production CARR and production hostnames", () => {
  const staging = config.env.staging;
  assert.equal(staging.name, "doctorcre-app-staging");
  assert.equal(staging.workers_dev, true);
  assert.deepEqual(staging.routes, []);
  assert.deepEqual(staging.services, [{ binding: "CARR", service: "carr-mcp-staging" }]);
  assert.equal(staging.vars.APP_ENV, "staging");
});

test("a CPU cap bounds every invocation in both environments", () => {
  // Workers Paid has no spend ceiling; without this each call may use the 30 s default.
  const cap = config.limits?.cpu_ms;
  assert.ok(Number.isInteger(cap) && cap > 0 && cap < 30_000, `limits.cpu_ms=${cap}`);
  const stagingCap = config.env.staging.limits?.cpu_ms ?? cap;
  assert.ok(stagingCap > 0 && stagingCap <= cap, `staging limits.cpu_ms=${stagingCap}`);
});
