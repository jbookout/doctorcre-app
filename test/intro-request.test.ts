import assert from "node:assert/strict";
import test from "node:test";
import { relationshipNetworkFixture } from "../js/relationship-network-fixture.js";
import { validNetwork } from "../js/relationship-network-model.js";
import { createIntroductionRequest, parseLinkReceipt } from "../src/ui/introduction-request.ts";

const from = "11111111-1111-4111-8111-111111111111",
  to = "22222222-2222-4222-8222-222222222222",
  via = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const value = relationshipNetworkFixture();
  for (const node of value.nodes) node.restricted = false;
  const replacements: [string, string][] = [
    ["party:demo-lender", `party:${from}`],
    ["party:demo-lead", `party:${to}`],
    ["party:demo-build", `party:${via}`],
  ];
  for (const [old, id] of replacements) {
    for (const n of value.nodes) if (n.id === old) n.id = id;
    const sides: ("from" | "to" | "via")[] = ["from", "to", "via"];
    for (const e of [...value.edges, ...value.suggestions]) for (const key of sides) if (e[key] === old) e[key] = id;
    for (const r of value.referrals) if (r.node_id === old) r.node_id = id;
  }
  assert.ok(value.edges[0]);
  assert.ok(value.suggestions[0]);
  value.edges[0].via = `party:${via}`;
  value.suggestions[0].via = `party:${via}`;
  assert.equal(validNetwork(value), true);
  return value;
}
const receipt = { ok: true, link_id: "44444444-4444-4444-8444-444444444444", existing: false };
type Write = NonNullable<ReturnType<ReturnType<typeof createIntroductionRequest>["view"]>["request"]>;
function harness() {
  const network = fixture(),
    calls: Write[] = [];
  let fail = false,
    refused = false,
    hold: Promise<unknown> | undefined;
  const client = {
    getRelationshipNetwork: async () => network,
    linkParties: async (args: Write) => {
      calls.push(structuredClone(args));
      if (refused) throw Object.assign(Error("Refused"), { payload: { error: "AUTHORIZATION_REFUSED" } });
      if (!network.edges.some((e) => e.id === `link:${receipt.link_id}`))
        network.edges.push({
          id: `link:${receipt.link_id}`,
          from: `party:${from}`,
          to: `party:${to}`,
          via: `party:${via}`,
          kind: "intro_requested",
          when: `${args.occurred_on}T00:00:00Z`,
          summary: args.note,
          detail: args.note,
        });
      network.suggestions = [];
      if (hold) await hold;
      if (fail) {
        fail = false;
        throw Error("lost response");
      }
      return receipt;
    },
  };
  const model = createIntroductionRequest({
    client,
    validNetwork,
    newKey: () => "55555555-5555-4555-8555-555555555555",
  });
  return {
    model,
    calls,
    client,
    get network() {
      return network;
    },
    lost() {
      fail = true;
    },
    refuse() {
      refused = true;
    },
    hold(p: Promise<unknown>) {
      hold = p;
    },
  };
}
test("selected path requires explicit review and preserves exact party identities", async () => {
  const h = harness();
  h.model.open(h.network, "demo-offer");
  assert.equal(h.calls.length, 0);
  await h.model.submit("2026-11-10", "Please connect these practices.", false);
  assert.equal(h.calls.length, 0);
  await h.model.submit("2026-11-10", "Please connect these practices.", true);
  assert.equal(h.model.view().status, "confirmed");
  assert.deepEqual(h.calls[0], {
    idempotency_key: "55555555-5555-4555-8555-555555555555",
    from_party: from,
    to_party: to,
    via_party: via,
    kind: "intro_requested",
    occurred_on: "2026-11-10",
    note: "Please connect these practices.",
  });
  assert.equal(h.network.edges.at(-1)?.kind, "intro_requested");
});
test("lost response blocks replacement and recovers with identical key after reopening", async () => {
  const h = harness();
  h.model.open(h.network, "demo-offer");
  h.lost();
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "unknown");
  h.model.open(h.network, "demo-offer");
  await h.model.submit("2026-11-11", "Changed note", true);
  assert.equal(h.calls.length, 1);
  await h.model.recover();
  assert.equal(h.model.view().status, "confirmed");
  assert.deepEqual(h.calls[0], h.calls[1]);
  assert.equal(h.network.edges.filter((e) => e.kind === "intro_requested").length, 1);
});
for (const mutation of ["restricted", "hold", "stale", "changed", "removed", "already-requested"])
  test(`fresh source refuses ${mutation}`, async () => {
    const h = harness();
    h.model.open(h.network, "demo-offer");
    assert.ok(h.network.nodes[0]);
    assert.ok(h.network.edges[0]);
    if (mutation === "restricted") h.network.nodes[0].restricted = true;
    if (mutation === "hold") h.network.nodes[0].contact_state = "paused";
    if (mutation === "stale") h.network.valid_until = "2000-01-01T00:00:00Z";
    if (mutation === "changed") h.network.nodes[0].name = "Changed identity label";
    if (mutation === "removed") h.network.suggestions = [];
    if (mutation === "already-requested")
      h.network.edges.push({ ...h.network.edges[0], id: "existing", kind: "intro_requested" });
    await h.model.submit("2026-11-10", "Note", true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.model.view().status, "changed_source");
  });
test("server refusal remains refused and reopening requires a new review", async () => {
  const h = harness();
  h.model.open(h.network, "demo-offer");
  h.refuse();
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "refused");
  h.model.open(h.network, "demo-offer");
  assert.equal(h.model.view().status, "reviewing");
});
test("retirement suppresses a late receipt and all later sends", async () => {
  const h = harness();
  const pending = Promise.withResolvers();
  h.hold(pending.promise);
  h.model.open(h.network, "demo-offer");
  const sending = h.model.submit("2026-11-10", "Note", true);
  await new Promise((r) => setImmediate(r));
  h.model.retire();
  pending.resolve(undefined);
  await sending;
  assert.equal(h.model.view().status, "retired");
  await h.model.recover();
  assert.equal(h.calls.length, 1);
});
test("receipt and exact canonical readback are both required", async () => {
  assert.throws(() => parseLinkReceipt({ ok: true }));
  assert.deepEqual(parseLinkReceipt(receipt), receipt);
  const h = harness();
  h.client.linkParties = async () => receipt;
  h.model.open(h.network, "demo-offer");
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "unknown");
});

test("direct offered paths omit a separate introducer without inventing one", async () => {
  const h = harness();
  assert.ok(h.network.edges[0]);
  assert.ok(h.network.suggestions[0]);
  h.network.edges[0].via = null;
  h.network.suggestions[0].via = null;
  h.client.linkParties = async (args) => {
    h.calls.push(args);
    h.network.edges.push({
      id: `link:${receipt.link_id}`,
      from: `party:${from}`,
      to: `party:${to}`,
      via: null,
      kind: "intro_requested",
      when: `${args.occurred_on}T00:00:00Z`,
      detail: args.note,
      summary: args.note,
    });
    h.network.suggestions = [];
    return receipt;
  };
  h.model.open(h.network, "demo-offer");
  await h.model.submit("2026-11-10", "Direct request", true);
  assert.equal(h.model.view().status, "confirmed");
  assert.equal(Object.hasOwn(h.calls[0] || {}, "via_party"), false);
});

test("invalid dates, empty notes, missing review, and double submission send no extra request", async () => {
  const h = harness();
  h.model.open(h.network, "demo-offer");
  for (const [date, note, reviewed] of [
    ["2026-02-30", "Note", true],
    ["2026-11-10", "", true],
    ["2026-11-10", "Note", false],
  ] satisfies [string, string, boolean][])
    await h.model.submit(date, note, reviewed);
  assert.equal(h.calls.length, 0);
  const first = h.model.submit("2026-11-10", "Note", true);
  await h.model.submit("2026-11-10", "Note", true);
  await first;
  assert.equal(h.calls.length, 1);
});

for (const state of ["reviewing", "unknown", "refused", "confirmed", "changed_source"])
  test(`retirement clears ${state} review and prevents further sends`, async () => {
    const h = harness();
    h.model.open(h.network, "demo-offer");
    if (state === "unknown") h.lost();
    if (state === "refused") h.refuse();
    if (state === "changed_source") h.network.suggestions = [];
    if (state !== "reviewing") await h.model.submit("2026-11-10", "Note", true);
    assert.equal(h.model.view().status, state);
    h.model.retire();
    assert.equal(h.model.view().path, null);
    assert.equal(h.model.view().request, null);
    const count = h.calls.length;
    h.model.open(h.network, "demo-offer");
    await h.model.submit("2026-11-10", "Note", true);
    await h.model.recover();
    assert.equal(h.calls.length, count);
    assert.equal(h.model.view().status, "retired");
  });

test("missing restriction evidence and an altered introducer refuse before dispatch", async () => {
  for (const change of ["missing-restriction", "introducer"]) {
    const h = harness();
    h.model.open(h.network, "demo-offer");
    assert.ok(h.network.nodes[0]);
    assert.ok(h.network.edges[0]);
    assert.ok(h.network.suggestions[0]);
    if (change === "missing-restriction") delete h.network.nodes[0].restricted;
    else {
      h.network.edges[0].via = null;
      h.network.suggestions[0].via = null;
    }
    await h.model.submit("2026-11-10", "Note", true);
    assert.equal(h.model.view().status, "changed_source");
    assert.equal(h.calls.length, 0);
  }
});

test("changed source requires reopening and explicitly reviewing its current identities", async () => {
  const h = harness();
  h.model.open(h.network, "demo-offer");
  assert.ok(h.network.nodes[0]);
  h.network.nodes[0].name = "Demo Updated Lending";
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "changed_source");
  assert.equal(h.calls.length, 0);
  h.model.open(h.network, "demo-offer");
  assert.equal(h.model.view().status, "reviewing");
  assert.equal(h.model.view().path?.from.name, "Demo Updated Lending");
  await h.model.submit("2026-11-10", "Note", false);
  assert.equal(h.calls.length, 0);
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "confirmed");
});
