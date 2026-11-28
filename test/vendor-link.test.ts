import assert from "node:assert/strict";
import test from "node:test";
import type { Role } from "../src/ui/deal-diagram.tsx";
import { type LinkValue, transitionLink, undoFor, type VendorLink } from "../src/ui/vendor-link.ts";

type Event = Parameters<typeof transitionLink>[1];
type State = VendorLink["state"];
const lender: Role = { role: "lender", label: "Lender" };
const title: Role = { role: "title", label: "Title" };
const empty: LinkValue = { party: null, introductions: [] };
const party = (roles: Role[]): LinkValue => ({
  introductions: [],
  party: { party_id: "vendor", name: "Example Vendor", roles, introduction_id: null },
});
const removal = { id: 1, roles: [lender, title] };
const add = { id: 2, operation: { kind: "add", role: lender, showSource: false } } as const;
const remove = { id: 2, operation: { kind: "remove", roles: [lender] } } as const;
const restore = { id: 2, operation: { kind: "restore", removal } } as const;
const failure = { ok: false, problem: { error: "not_found" } } as const;
const states: State[] = [
  { kind: "idle" },
  { kind: "saving", save: add, slow: false },
  { kind: "unconfirmed", save: add, checking: true },
  { kind: "refused", save: add, failure },
  { kind: "undoable", removal, retried: false },
];
const makeLink = (state: State, value: LinkValue = empty): VendorLink => ({
  ...value,
  deal: "deal",
  vendor: "vendor",
  name: "Example Vendor",
  revision: 2,
  state,
});
function received(value: LinkValue, revision = 4): Event {
  return { type: "read", revision, value };
}
const matrix: { event: Event; expected: (State["kind"] | "same")[] }[] = [
  { event: { type: "begin", save: { ...add, id: 3 } }, expected: ["saving", "same", "same", "saving", "saving"] },
  { event: { type: "deadline", id: 2 }, expected: ["same", "saving", "same", "same", "same"] },
  {
    event: { type: "answer", id: 2, revision: 3, answer: { ok: true }, changes: party([lender]) },
    expected: ["same", "idle", "same", "same", "same"],
  },
  { event: { type: "check", revision: 3 }, expected: ["same", "same", "unconfirmed", "same", "same"] },
  { event: { type: "read-failed", revision: 3 }, expected: ["same", "same", "unconfirmed", "same", "same"] },
  { event: received(party([lender])), expected: ["idle", "same", "idle", "idle", "idle"] },
  { event: { type: "expire", id: 1 }, expected: ["same", "same", "same", "same", "idle"] },
];

for (const { event, expected } of matrix) {
  for (const [index, state] of states.entries()) {
    test(`${event.type} in ${state.kind}`, () => {
      const link = makeLink(state);
      const next = transitionLink(link, event);
      if (expected[index] === "same") assert.equal(next, link);
      else {
        assert.notEqual(next, link);
        assert.equal(next.state.kind, expected[index]);
      }
    });
  }
}

test("only the active save can cross the deadline or settle as refused or unconfirmed", () => {
  const link = makeLink({ kind: "saving", save: add, slow: false });
  const deadline = { type: "deadline", id: 1 } as const;
  const answer = { type: "answer", id: 1, revision: 3, answer: failure, changes: {} } as const;
  assert.equal(transitionLink(link, deadline), link);
  assert.equal(transitionLink(link, answer), link);
  assert.deepEqual(transitionLink(link, { ...deadline, id: 2 }).state, { ...link.state, slow: true });
  assert.deepEqual(transitionLink(link, { ...answer, id: 2 }).state, { kind: "refused", save: add, failure });
  assert.deepEqual(transitionLink(link, { ...answer, id: 2, answer: { ok: false, pending: true } }).state, {
    kind: "unconfirmed",
    save: add,
    checking: false,
  });
});

test("stale reads cannot replace the value or complete a newer check", () => {
  const link = makeLink({ kind: "unconfirmed", save: add, checking: true });
  assert.equal(transitionLink(link, received(party([lender]), 2)), link);
  assert.equal(transitionLink(link, { type: "read-failed", revision: 2 }), link);
  const failed = transitionLink(link, { type: "read-failed", revision: 3 });
  assert.deepEqual(failed.state, { kind: "unconfirmed", save: add, checking: false });
  const unrelatedRead = transitionLink(failed, received(party([lender])));
  assert.deepEqual(unrelatedRead.party, party([lender]).party);
  assert.deepEqual(unrelatedRead.state, failed.state);
});

test("the current removal id is required to begin or expire Undo", () => {
  const link = makeLink({ kind: "saving", save: remove, slow: false }, party([lender]));
  const removed = transitionLink(link, { type: "answer", id: 2, revision: 3, answer: { ok: true }, changes: empty });
  assert.deepEqual(undoFor(removed), { id: 2, roles: [lender] });
  assert.equal(transitionLink(removed, { type: "expire", id: 1 }), removed);
  const stale = { ...restore, id: 4 };
  assert.equal(transitionLink(removed, { type: "begin", save: stale }), removed);
  const current = { ...stale, operation: { kind: "restore", removal: { id: 2, roles: [lender] } } } as const;
  assert.equal(transitionLink(removed, { type: "begin", save: current }).state.kind, "saving");
});

test("a confirmed restore retires its Undo permanently even if the roles are removed later", () => {
  const link = makeLink({ kind: "unconfirmed", save: restore, checking: true });
  const confirmed = transitionLink(link, received(party([lender, title])));
  assert.equal(confirmed.state.kind, "idle");
  assert.equal(undoFor(confirmed), undefined);
  const later = transitionLink(confirmed, received(empty, 5));
  assert.deepEqual(later.state, { kind: "idle" });
  assert.equal(transitionLink(later, { type: "begin", save: { ...restore, id: 6 } }), later);
});

test("a checked partial restore offers the remaining roles until a fresh change supersedes it", () => {
  const link = makeLink({ kind: "unconfirmed", save: restore, checking: true });
  const partial = transitionLink(link, received(party([lender])));
  assert.deepEqual(partial.state, { kind: "undoable", removal, retried: true });
  assert.equal(transitionLink(partial, { type: "expire", id: removal.id }), partial);
  assert.equal(transitionLink(partial, received(party([lender]), 5)).state, partial.state);
  assert.deepEqual(transitionLink(partial, received(empty, 6)).state, { kind: "idle" });
});

test("a refused Add survives unchanged roles and clears once a fresh read finds the requested role", () => {
  const link = makeLink({ kind: "refused", save: add, failure });
  assert.equal(transitionLink(link, received(party([title]))).state, link.state);
  assert.deepEqual(transitionLink(link, received(party([lender]))).state, { kind: "idle" });
});

test("a refused restore cannot be retried after its role snapshot is superseded", () => {
  const link = makeLink({ kind: "refused", save: restore, failure }, party([lender]));
  assert.equal(transitionLink(link, received(party([lender]))).state, link.state);
  assert.equal(undoFor(transitionLink(link, received(empty))), undefined);
});

const conflictingSource: LinkValue = {
  ...empty,
  introductions: [
    {
      id: "intro",
      vendor_id: "vendor",
      vendor_name: "Example Vendor",
      made_by: "team",
      introduced_by: "dell",
      introduced_on: null,
      introduced_party_id: "client",
      introduced_party_name: "Example Client",
      note: null,
      chosen: false,
    },
  ],
};
const sourceRefused: State = {
  kind: "refused",
  save: { id: 2, operation: { kind: "source", by: "joe" } },
  failure: { ok: false, problem: { error: "introduction_already_recorded" } },
};
const rejectedAdd: State = { kind: "refused", save: add, failure };
const refusalCases: { name: string; link: VendorLink; event: Event; state: State }[] = [
  {
    name: "read in refused Set clears an absent source conflict",
    link: makeLink(sourceRefused, conflictingSource),
    event: received(empty),
    state: { kind: "idle" },
  },
  {
    name: "read in refused Set keeps a conflict that still exists",
    link: makeLink(sourceRefused, conflictingSource),
    event: received(conflictingSource),
    state: sourceRefused,
  },
  {
    name: "answer in saving records a refused Not recorded Add on a link without a vendor box",
    link: makeLink({ kind: "saving", save: add, slow: false }),
    event: { type: "answer", id: 2, revision: 3, answer: failure, changes: {} },
    state: rejectedAdd,
  },
  {
    name: "read in refused Not recorded Add retains the refusal without a vendor box",
    link: makeLink(rejectedAdd),
    event: received(empty),
    state: rejectedAdd,
  },
];
for (const { name, link, event, state } of refusalCases) {
  test(name, () => {
    const next = transitionLink(link, event);
    assert.deepEqual(next.state, state);
    if (event.type === "read") assert.deepEqual(next.introductions, event.value.introductions);
  });
}
