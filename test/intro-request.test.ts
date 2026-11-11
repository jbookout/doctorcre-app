import assert from "node:assert/strict";
import test from "node:test";
import type { relationshipNetworkFixture } from "../js/relationship-network-fixture.js";
import { validNetwork } from "../js/relationship-network-model.js";
import { createIntroductionRequest, parseLinkReceipt } from "../src/ui/introduction-request.ts";

import recorded from "./fixtures/introduction-request.json" with { type: "json" };

const offerId = recorded.snapshot.edges[0]?.id;
assert.ok(offerId);

const from = "11111111-1111-4111-8111-111111111111",
  to = "22222222-2222-4222-8222-222222222222",
  via = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const value: ReturnType<typeof relationshipNetworkFixture> = structuredClone(recorded.snapshot);
  value.observed_at = new Date().toISOString();
  value.valid_until = new Date(Date.now() + 120_000).toISOString();
  const roleIds = [
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ];
  for (const [index, node] of value.nodes.entries()) node.record_id = roleIds[index] || node.record_id;
  assert.equal(validNetwork(value), true);
  return value;
}
const receipt = recorded.created;
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
          from: `party:${args.from_party}`,
          to: `party:${args.to_party}`,
          via: args.via_party ? `party:${args.via_party}` : null,
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
  h.model.open(h.network, offerId);
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
  h.model.open(h.network, offerId);
  h.lost();
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "unknown");
  h.model.open(h.network, offerId);
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
    h.model.open(h.network, offerId);
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
  h.model.open(h.network, offerId);
  h.refuse();
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "refused");
  h.model.open(h.network, offerId);
  assert.equal(h.model.view().status, "reviewing");
});
test("retirement suppresses a late receipt and all later sends", async () => {
  const h = harness();
  const pending = Promise.withResolvers();
  h.hold(pending.promise);
  h.model.open(h.network, offerId);
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
  h.model.open(h.network, offerId);
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "unknown");
});

test("direct offered paths omit a separate introducer without inventing one", async () => {
  const h = harness();
  assert.ok(h.network.edges[0]);
  assert.ok(h.network.suggestions[0]);
  h.network.edges[0].via = null;
  h.network.suggestions[0].via = null;
  h.model.open(h.network, offerId);
  await h.model.submit("2026-11-10", "Direct request", true);
  assert.equal(h.model.view().status, "confirmed");
  assert.equal(Object.hasOwn(h.calls[0] || {}, "via_party"), false);
});

test("invalid dates, empty notes, missing review, and double submission send no extra request", async () => {
  const h = harness();
  h.model.open(h.network, offerId);
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

for (const state of ["selected", "reviewing", "unknown", "refused", "confirmed", "changed_source"])
  test(`retirement clears ${state} review and prevents further sends`, async () => {
    const h = harness();
    if (state !== "selected") h.model.open(h.network, offerId);
    if (state === "unknown") h.lost();
    if (state === "refused") h.refuse();
    if (state === "changed_source") h.network.suggestions = [];
    if (state !== "reviewing") await h.model.submit("2026-11-10", "Note", true);
    assert.equal(h.model.view().status, state);
    h.model.retire();
    assert.equal(h.model.view().path, null);
    assert.equal(h.model.view().request, null);
    const count = h.calls.length;
    h.model.open(h.network, offerId);
    await h.model.submit("2026-11-10", "Note", true);
    await h.model.recover();
    assert.equal(h.calls.length, count);
    assert.equal(h.model.view().status, "retired");
  });

test("missing restriction evidence and an altered introducer refuse before dispatch", async () => {
  for (const change of ["missing-restriction", "introducer"]) {
    const h = harness();
    h.model.open(h.network, offerId);
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
  h.model.open(h.network, offerId);
  assert.ok(h.network.nodes[0]);
  h.network.nodes[0].name = "Demo Updated Lending";
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "changed_source");
  assert.equal(h.calls.length, 0);
  h.model.open(h.network, offerId);
  assert.equal(h.model.view().status, "reviewing");
  assert.equal(h.model.view().path?.from.name, "Demo Updated Lending");
  await h.model.submit("2026-11-10", "Note", false);
  assert.equal(h.calls.length, 0);
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "confirmed");
});

test("recorded producer receipts and snapshots pass the production parsers", () => {
  assert.equal(recorded.producer.database_connections, 0);
  assert.equal(recorded.producer.production_writes, 0);
  for (const response of [recorded.created, recorded.replayed, recorded.existing])
    assert.equal(parseLinkReceipt(response).link_id, recorded.created.link_id);
  assert.equal(validNetwork(recorded.snapshot), true);
  assert.equal(validNetwork(recorded.requested), true);
  assert.equal(recorded.requested.suggestions.length, 0);
});

test("transport session refusal retires and clears the retained review", async () => {
  const h = harness();
  h.client.linkParties = async () => {
    throw Object.assign(Error("Session changed"), { code: "session_changed" });
  };
  h.model.open(h.network, offerId);
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "retired");
  assert.equal(h.model.view().path, null);
  assert.equal(h.model.view().request, null);
});

test("review selects the named offered path and preserves the exact note", async () => {
  const h = harness();
  assert.ok(h.network.nodes[2]);
  assert.ok(h.network.edges[0]);
  assert.ok(h.network.suggestions[0]);
  const otherId = "99999999-9999-4999-8999-999999999999";
  h.network.nodes.push({
    ...h.network.nodes[2],
    id: `party:${otherId}`,
    name: "Demo Other Practice",
    ref: "DEMO-OTHER",
  });
  const selected = {
    ...h.network.suggestions[0],
    id: "link:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    to: `party:${otherId}`,
  };
  h.network.suggestions.push(selected);
  h.network.edges.push({ ...h.network.edges[0], id: selected.id, to: selected.to });
  h.model.open(h.network, selected.id);
  assert.equal(h.model.view().path?.to.name, "Demo Other Practice");
  const note = "  Demo note with\nline breaks.  ";
  await h.model.submit("2026-11-10", note, true);
  assert.equal(h.model.view().status, "confirmed");
  assert.equal(h.calls[0]?.to_party, otherId);
  assert.equal(h.calls[0]?.note, note);
});

for (const state of ["selected", "reviewing", "refused", "confirmed", "changed_source"])
  test(`unavailable offered path stays unwritable from ${state}`, async () => {
    const h = harness();
    if (state !== "selected") h.model.open(h.network, offerId);
    if (state === "refused") h.refuse();
    if (state === "changed_source") h.network.suggestions = [];
    if (["refused", "confirmed", "changed_source"].includes(state)) await h.model.submit("2026-11-10", "Note", true);
    assert.equal(h.model.view().status, state);
    const unavailable = fixture();
    unavailable.valid_until = "2000-01-01T00:00:00Z";
    const count = h.calls.length;
    h.model.open(unavailable, offerId);
    assert.equal(h.model.view().status, "changed_source");
    await h.model.submit("2026-11-10", "Note", true);
    assert.equal(h.calls.length, count);
  });

test("a recorded request can return to review without duplicating its write", async () => {
  const h = harness(),
    earlier = structuredClone(h.network);
  h.model.open(h.network, offerId);
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "confirmed");
  h.model.open(earlier, offerId);
  assert.equal(h.model.view().status, "reviewing");
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.model.view().status, "changed_source");
  assert.equal(h.calls.length, 1);
});

test("an unavailable fresh read blocks writing without claiming the source changed", async () => {
  const h = harness();
  h.model.open(h.network, offerId);
  h.client.getRelationshipNetwork = async () => {
    throw Object.assign(Error("Unavailable"), { status: 503 });
  };
  await h.model.submit("2026-11-10", "Note", true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.model.view().status, "changed_source");
  assert.equal(h.model.view().message, "This offered path could not be verified. Refresh and review it again.");
});

for (const mutation of ["restricted", "removed", "stale", "changed", "already-requested"])
  test(`uncommitted recovery revalidates ${mutation} before any new write`, async () => {
    const h = harness();
    h.model.open(h.network, offerId);
    const write = h.client.linkParties;
    h.client.linkParties = async () => {
      throw Error("failed before commit");
    };
    await h.model.submit("2026-11-10", "Note", true);
    assert.equal(h.model.view().status, "unknown");
    h.client.linkParties = write;
    assert.ok(h.network.nodes[0]);
    assert.ok(h.network.edges[0]);
    if (mutation === "restricted") h.network.nodes[0].restricted = true;
    if (mutation === "removed") h.network.suggestions = [];
    if (mutation === "stale") h.network.valid_until = "2000-01-01T00:00:00Z";
    if (mutation === "changed") h.network.nodes[0].name = "Changed identity";
    if (mutation === "already-requested") h.network.edges.push({ ...h.network.edges[0], kind: "intro_requested" });
    await h.model.recover();
    assert.equal(h.calls.length, 0);
    assert.equal(h.model.view().status, "unknown");
  });

test("committed recovery remains possible after offer suppression and endpoint restriction", async () => {
  const h = harness();
  h.model.open(h.network, offerId);
  h.lost();
  await h.model.submit("2026-11-10", "Note", true);
  assert.ok(h.network.nodes[0]);
  h.network.nodes[0].restricted = true;
  h.network.suggestions = [];
  await h.model.recover();
  assert.equal(h.model.view().status, "confirmed");
  assert.equal(h.network.edges.filter((e) => e.kind === "intro_requested").length, 1);
});

test("uncommitted recovery retains its key when current eligibility is verified", async () => {
  const h = harness();
  h.model.open(h.network, offerId);
  const write = h.client.linkParties;
  const attempted: Write[] = [];
  h.client.linkParties = async (args) => {
    attempted.push(args);
    throw Error("failed before commit");
  };
  await h.model.submit("2026-11-10", "Note", true);
  h.client.linkParties = write;
  await h.model.recover();
  assert.equal(h.model.view().status, "confirmed");
  assert.deepEqual(h.calls[0], attempted[0]);
});

for (const failure of [{ status: 401 }, { status: 403 }, { code: "session_changed" }])
  test(`preflight session refusal clears the review ${JSON.stringify(failure)}`, async () => {
    const h = harness();
    h.model.open(h.network, offerId);
    h.client.getRelationshipNetwork = async () => {
      throw Object.assign(Error("Session ended"), failure);
    };
    await h.model.submit("2026-11-10", "Private note", true);
    assert.equal(h.model.view().status, "retired");
    assert.equal(h.model.view().path, null);
    assert.equal(h.model.view().request, null);
    assert.equal(h.calls.length, 0);
  });

for (const rejects of [false, true])
  test(`retirement ignores a pending preflight that ${rejects ? "rejects" : "resolves"} later`, async () => {
    const h = harness();
    h.model.open(h.network, offerId);
    const pending = Promise.withResolvers<ReturnType<typeof fixture>>();
    h.client.getRelationshipNetwork = () => pending.promise;
    const sending = h.model.submit("2026-11-10", "Private note", true);
    h.model.retire();
    if (rejects) pending.reject(Object.assign(Error("Session ended"), { status: 401 }));
    else pending.resolve(h.network);
    await sending;
    assert.equal(h.model.view().status, "retired");
    assert.equal(h.model.view().path, null);
    assert.equal(h.model.view().request, null);
    assert.equal(h.calls.length, 0);
  });

test("unavailable recovery read retains unknown intent until reconciliation can finish", async () => {
  const h = harness();
  h.model.open(h.network, offerId);
  h.lost();
  await h.model.submit("2026-11-10", "Note", true);
  const read = h.client.getRelationshipNetwork;
  h.client.getRelationshipNetwork = async () => {
    throw Error("Unavailable");
  };
  await h.model.recover();
  assert.equal(h.model.view().status, "unknown");
  h.model.open(h.network, offerId);
  await h.model.submit("2026-11-11", "Replacement", true);
  assert.equal(h.calls.length, 1);
  h.client.getRelationshipNetwork = read;
  await h.model.recover();
  assert.equal(h.model.view().status, "confirmed");
});
