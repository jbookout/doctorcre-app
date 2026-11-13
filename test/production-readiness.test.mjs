import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

test("production can reach CARR without making the app publicly routable", () => {
  assert.equal(config.name, "doctorcre-app");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []);
  assert.deepEqual(config.services, [
    { binding: "CARR", service: "carr-mcp" },
    { binding: "ENGINE", service: "doctorcre-engine" },
  ]);
  assert.deepEqual(config.kv_namespaces, [{ binding: "DEALS_ROUTING", id: "1b69f9569abb4f33b22356bd621349d4" }]);
  assert.equal(config.vars.APP_ENV, "production");
});

test("staging remains isolated from production CARR and production hostnames", () => {
  const staging = config.env.staging;
  assert.equal(staging.name, "doctorcre-app-staging");
  assert.equal(staging.workers_dev, true);
  assert.deepEqual(staging.routes, []);
  assert.deepEqual(staging.services, [
    { binding: "CARR", service: "carr-mcp-staging" },
    { binding: "ENGINE", service: "doctorcre-engine-staging" },
  ]);
  assert.deepEqual(staging.kv_namespaces, [{ binding: "DEALS_ROUTING", id: "1b69f9569abb4f33b22356bd621349d4" }]);
  assert.equal(staging.vars.APP_ENV, "staging");
});

test("a CPU cap bounds every invocation in both environments", () => {
  // Workers Paid has no spend ceiling; without this each call may use the 30 s default.
  const cap = config.limits?.cpu_ms;
  assert.ok(Number.isInteger(cap) && cap > 0 && cap < 30_000, `limits.cpu_ms=${cap}`);
  const stagingCap = config.env.staging.limits?.cpu_ms ?? cap;
  assert.ok(stagingCap > 0 && stagingCap <= cap, `staging limits.cpu_ms=${stagingCap}`);
});

test("every Worker environment samples logs below full volume", () => {
  for (const [name, environment] of [['production', config], ...Object.entries(config.env)]) {
    const rate = environment.observability?.head_sampling_rate;
    assert.ok(typeof rate === 'number' && rate >= 0 && rate < 1,
      `${name} requires an explicit head_sampling_rate in [0, 1)`);
  }
  assert.equal(config.observability.head_sampling_rate, 0.1);
  assert.equal(config.env.staging.observability.head_sampling_rate, 0.01);
});

test("only the Access-gated staging Worker enables workers.dev and no environment enables previews", () => {
  for (const [name, environment] of [['production', config], ...Object.entries(config.env)]) {
    assert.equal(environment.preview_urls, false, `${name} must explicitly disable preview_urls`);
    assert.deepEqual(environment.routes, [], `${name} must not add routes`);
    assert.equal(environment.workers_dev, name === 'staging', `${name} workers_dev must match the staging exception`);
    if (name === 'staging') {
      assert.equal(environment.name, 'doctorcre-app-staging');
      assert.equal(environment.account_id ?? config.account_id, '12ccca77eb49142a6be8eb84c0d6a3a0');
    }
  }
});
