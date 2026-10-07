import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { relationshipNetworkFixture } from "../js/relationship-network-fixture.js";
import {
  validNetwork,
  filterNetwork,
  introductionSuggestions,
  focusedNetwork,
  escapeHtml,
} from "../js/relationship-network-model.js";
import { escapeText } from "../js/change-receipts.mjs";
import { createLiveClient } from "../js/live-client.js";
test("relationship rendering uses the shared HTML escaping rule", () => {
  assert.equal(escapeHtml, escapeText);
  assert.equal(escapeHtml(`<a title="O'Brien">&`), '&lt;a title=&quot;O&#39;Brien&quot;&gt;&amp;');
});
test("relationship contract pins canonical bytes and the versioned selector", async () => {
  const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1.json', import.meta.url)));
  const bytes = await readFile(new URL('../contracts/relationship-network.v1.json', import.meta.url));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(contract.relationship_network.sha256, digest);
  assert.equal(contract.relationship_network.schema, 'carr-relationship-network.v1');
  assert.equal(contract.relationship_network.request_selector, 'contract=relationship-network.v1');
});
test("network validates identities, aggregates and introduction reasons", () => {
  const value = relationshipNetworkFixture();
  assert.equal(validNetwork(value), true);
  for (const mutate of [
    (s) => s.nodes.push(s.nodes[0]),
    (s) => (s.edges[0].from = "missing"),
    (s) => (s.edges[0].via = "missing"),
    (s) => (s.edges[0].kind = "guess"),
    (s) => (s.referrals[0].win_rate = 0.5),
    (s) => (s.referrals[0].won = 3),
    (s) => (s.suggestions[0].id = "missing"),
    (s) => (s.suggestions[0].reason = ""),
    (s) => (s.valid_until = s.observed_at),
  ]) {
    const s = structuredClone(value);
    mutate(s);
    assert.equal(validNetwork(s), false);
  }
});
test("filters intersect and preserve closed exact graph links", () => {
  const value = relationshipNetworkFixture(),
    coast = filterNetwork(value, {
      territory: "Demo Coast",
      vertical: "dental",
    });
  assert.equal(coast.nodes.length, 6);
  const ids = new Set(coast.nodes.map((n) => n.id));
  assert.ok(coast.edges.every((e) => ids.has(e.from) && ids.has(e.to)));
  assert.equal(
    filterNetwork(value, { territory: "Demo Inland", vertical: "dental" }).nodes
      .length,
    0,
  );
  assert.equal(filterNetwork(value, { q: "LENDING" }).nodes.length, 1);
});
test("Home shares graph reason, exact endpoints and owner scope", () => {
  const value = relationshipNetworkFixture(),
    intros = introductionSuggestions(value);
  assert.equal(intros[0].reason, value.suggestions[0].reason);
  assert.equal(intros[0].toNode.kind, "lead");
  assert.equal(
    introductionSuggestions(value, { scope: "mine", actor: "dell" }).length,
    0,
  );
  const graph = focusedNetwork(value, "party:demo-lender", 4);
  assert.equal(graph.nodes.length, 4);
  assert.ok(graph.nodes.some((n) => n.id === "party:demo-lead"));
  assert.equal(graph.total, 8);
});
test("live read pins selector, abort and authenticated transport; auth status survives", async () => {
  let request;
  const live = createLiveClient({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify(relationshipNetworkFixture()));
    },
  });
  assert.equal(
    validNetwork(
      await live.getRelationshipNetwork({
        signal: new AbortController().signal,
      }),
    ),
    true,
  );
  assert.match(request.url, /relationships\?contract=relationship-network.v1/);
  assert.equal(request.init.credentials, "same-origin");
  assert.ok(request.init.signal);
  await assert.rejects(
    createLiveClient({
      fetchImpl: async () => new Response("", { status: 401 }),
    }).getRelationshipNetwork(),
    (e) => e.status === 401,
  );
});

test('R7 rejects malformed optional text fields and null relationship rows before typed rendering',()=>{
 for(const [section,field] of [['nodes','territory'],['nodes','summary'],['nodes','owner'],['nodes','contact_state'],['edges','summary'],['edges','detail'],['edges','when']]) {
  const s=relationshipNetworkFixture();s[section][0][field]=123;assert.equal(validNetwork(s),false,`${section}.${field}`);
 }
 for(const section of ['referrals','suggestions']) {const s=relationshipNetworkFixture();s[section][0]=null;assert.equal(validNetwork(s),false);}
});
