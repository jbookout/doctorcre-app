import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLiveClient } from "../js/live-client.js";
import { createFixtureClient } from "../js/fixture-client.js";
import { projectResourceDashboard } from "../js/resource-dashboard-model.js";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const names = ["neon", "github", "cloudflare", "local_compute", "model_route"];
const empty = (provider) => ({ provider, state: ["neon", "github", "cloudflare"].includes(provider) ? "unconfigured" : "collector_absent",
  reason: "no collector observation received yet", period: null, as_of: null, source: null, observed_at: null,
  quantity: null, quantity_unit: null, allowance: null, policy: null, estimate: null, charge: null,
  measured_capacity: null, configured_capacity: null, model_route: null, account: null, project: null, product: null });
const dashboard = (rows = names.map(empty)) => ({ ok: true, schema: "doctorcre-resource-dashboard.v1",
  generated_at: "2026-09-28T21:00:00Z", providers: rows });

test("the five provider slots stay visible when no collector has reported", () => {
  const model = projectResourceDashboard(dashboard());
  assert.deepEqual(model.providers.map((row) => row.provider), names);
  assert.equal(model.evidenceCount, 0);
  assert.equal(model.unconfiguredCount, 3);
  assert.equal(model.collectorAbsentCount, 2);
  assert.equal(model.providers[0].quantity, null);
  assert.equal(model.providers[0].source, null);
});

test("zero measured use, policy, estimate and charge remain separate facts", () => {
  const row = { ...empty("neon"), state: "ok", quantity: 0, quantity_unit: "compute hours",
    allowance: 100, policy: { monthly_ceiling: 200 }, estimate: 14.25, charge: 12.50,
    source: "provider API", period: "2026-09", as_of: "2026-09-28T20:58:00Z", observed_at: "2026-09-28T20:59:00Z" };
  const model = projectResourceDashboard(dashboard([row, ...names.slice(1).map(empty)]));
  assert.equal(model.evidenceCount, 1);
  assert.equal(model.providers[0].quantity,0);
  assert.equal(model.providers[0].allowance,100);
  assert.equal(model.providers[0].policy.monthly_ceiling,200);
  assert.equal(model.providers[0].estimate,14.25);
  assert.equal(model.providers[0].charge,12.5);
});

test("a stale row keeps its source dates and values but is visibly stale", () => {
  const stale = { ...empty("github"), state: "stale", quantity: 23, quantity_unit: "minutes",
    source: "provider API", period: "2026-09", as_of: "2026-09-28T18:00:00Z",
    observed_at: "2026-09-28T18:02:00Z", reason: "observation is 178 minutes old" };
  const model = projectResourceDashboard(dashboard(names.map((name) => name === "github" ? stale : empty(name))));
  assert.equal(model.providers[1].state, "stale");
  assert.equal(model.providers[1].as_of, stale.as_of);
  assert.equal(model.providers[1].reason, stale.reason);
  assert.equal(model.evidenceCount, 1);
});

test("a partial row or missing provider never becomes a zero or an invented reading", () => {
  const partial = { ...empty("cloudflare"), state: "partial", source: "provider API", quantity: null,
    charge: 0, reason: "usage endpoint unavailable", observed_at: "2026-09-28T20:59:00Z" };
  const model = projectResourceDashboard(dashboard([partial, empty("neon")]));
  assert.equal(model.providers.length, 5);
  assert.equal(model.providers[2].state, "partial");
  assert.equal(model.providers[2].quantity, null);
  assert.equal(model.providers[2].charge, 0);
  assert.equal(model.providers[1].state, "unknown");
});


test("the fixture mirrors the live empty contract and a resource-only outage", async () => {
  const seed = await read("data/board-seed.json");
  const seedUrl = `data:application/json;base64,${Buffer.from(seed).toString("base64")}`;
  const client = await createFixtureClient({ seedUrl });
  assert.deepEqual(projectResourceDashboard(await client.readResourceDashboard()).providers.map((row) => row.state),
    ["unconfigured", "unconfigured", "unconfigured", "collector_absent", "collector_absent"]);
  const outage = await createFixtureClient({ seedUrl, outage: "resources" });
  await assert.rejects(() => outage.readResourceDashboard());
  assert.equal((await outage.currentWorkItem()).ok, true);
});

test("the live client calls the pinned read with no arguments", async () => {
  const calls = [];
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    calls.push({ path, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify(dashboard()) }] } }) };
  } });
  assert.equal((await client.readResourceDashboard()).schema, "doctorcre-resource-dashboard.v1");
  assert.equal(calls[0].path, "/mcp");
  assert.equal(calls[0].body.params.name, "read-resource-dashboard");
  assert.deepEqual(calls[0].body.params.arguments, {});
});

test("Connections replaces the resource card inside the shared room",async()=>{
 const html=await readFile(new URL('../control-room.html',import.meta.url),'utf8');
 assert.match(html,/id="connectionsProviders"/);assert.doesNotMatch(html,/id="resourceDashboard"/);
});
