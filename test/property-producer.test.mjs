import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const contract = JSON.parse(await readFile(new URL("../contracts/carr-interface.v1.json", import.meta.url), "utf8"));
const mergedProducer = "0cc6fe2538a81521bf8c25b0df58aa4063ed614b";

test("property evidence pins the merged CARR PR 1400 producer", () => {
  assert.equal(contract.producer.source_commit, mergedProducer);
});

// Opt-in cross-repository verification reads committed source, never a working
// tree or database. The ordinary app suite remains offline and self-contained.
test("the exact pinned producer serves property evidence alongside the existing Tour reads", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify the pinned producer",
}, async () => {
  const git = (...args) => execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT, ...args], { encoding: "utf8" });
  const pin = contract.producer.source_commit;
  const source = git("show", `${pin}:mcp-server/src/tour-internal-web.js`);
  const { createTourInternalWebHandler, isTourInternalRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const propertyId = "10000000-0000-4000-8000-000000000001";
  const asOf = "2026-09-29T12:00:00.000Z";
  const data = { schema: "tour-property-evidence.v1", property_id: propertyId, as_of: asOf, facts: {} };
  const calls = [];
  const handler = createTourInternalWebHandler({
    readPropertyEvidenceFn: async context => { calls.push(context); return { ok: true, data }; },
    listToursFn: async () => ({ ok: true, data: { tours: [] } }),
    readTourSelectionCartFn: async () => ({ ok: true, data: { stops: [] } }),
  });
  const request = new Request(`https://app.doctorcre.com/api/tours/property-evidence/v1?property_id=${propertyId}&as_of=${encodeURIComponent(asOf)}`);
  const env = { APP_HOST: "app.doctorcre.com" };
  const actor = { id: "synthetic-partner" };
  const session = { csrfToken: "synthetic-csrf" };
  const response = await handler.fetch(request, env, {}, actor, session);
  assert.equal(response.status, 200, `property evidence must exist at ${pin}`);
  assert.equal(isTourInternalRequest(request), true);
  assert.deepEqual(await response.json(), { data, csrf_token: session.csrfToken });
  assert.deepEqual(calls[0].input, { property_id: propertyId, as_of: asOf });
  assert.deepEqual(calls[0].actor, actor);
  assert.equal((await handler.fetch(request, env, {})).status, 401);
  for (const path of ["/api/tours/library", `/api/tours/selection-cart?tour_id=${propertyId}`]) {
    assert.equal((await handler.fetch(new Request(`https://app.doctorcre.com${path}`), env, {}, actor, session)).status, 200);
  }
  git("merge-base", "--is-ancestor", "c4f1ad45273175c26c074336c0fecbf789718348", pin);
  git("merge-base", "--is-ancestor", pin, "origin/main");
});
