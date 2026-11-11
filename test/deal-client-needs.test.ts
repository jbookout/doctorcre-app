import assert from "node:assert/strict";
import test from "node:test";
import { createNeedAuthor, parseNeed, parseNeeds } from "../src/ui/deal-client-needs-model.ts";

const id = "11111111-1111-4111-8111-111111111111";
const client = "22222222-2222-4222-8222-222222222222";
const need = {
  id,
  deal_id: id,
  client_id: client,
  vendor_id: id,
  version: 1,
  revision: 1,
  source_ref: "Synthetic call",
  source_revision: "call-1",
  applicability: "Buildout",
  restriction: "allowed" as const,
  observed_at: "2026-01-01T00:00:00Z",
  fresh_until: "2099-01-01T00:00:00Z",
  approved_revision: null,
  approved_by: null,
  approved_at: null,
  state: "draft",
  description: "Synthetic need",
  client_name: "Synthetic client",
  deal_name: "Synthetic deal",
  vendor_ref: "V-1",
  identity_restricted: false,
};
const page = (rows: unknown[] = [need]) => ({
  schema_version: "client-needs.v1",
  subject: "deal",
  subject_id: id,
  as_of: "2026-11-11T00:00:00Z",
  state: rows.length ? "ready" : "empty",
  rows,
  next_offset: null,
});
test("contract rejects cross-deal and cross-client substitution", () => {
  assert.equal(parseNeeds(page(), { deal: id, client, offset: 0 }).rows.length, 1);
  for (const row of [
    { ...need, deal_id: client },
    { ...need, client_id: id },
  ])
    assert.throws(() => parseNeeds(page([row]), { deal: id, client, offset: 0 }));
  assert.throws(() => parseNeed({ ...need, version: 0 }, { deal: id, client }));
});
test("review cancel never writes; approval sends displayed version; edit lapses approval", async () => {
  const calls: { verb: string; args: Record<string, unknown> }[] = [];
  const model = createNeedAuthor({
    deal: id,
    client,
    call: async (verb, args) => {
      calls.push({ verb, args });
      if (verb.startsWith("read")) return page();
      return {
        schema_version: "client-needs.v1",
        need: {
          ...need,
          version: 2,
          state: verb.startsWith("approve") ? "approved" : "edited_lapsed",
          approved_revision: verb.startsWith("approve") ? 1 : null,
        },
      };
    },
    changed() {},
  });
  await model.load();
  model.review(need.id);
  model.cancel();
  assert.equal(calls.length, 1);
  model.review(need.id);
  await model.approve();
  assert.equal(calls[1]?.args.base_version, 1);
  assert.equal(String(model.state.kind), "listing");
  model.edit(need.id);
  await model.save({ ...need, vendor: id, withdrawn: false });
  assert.equal(model.rows[0]?.state, "edited_lapsed");
});
test("unknown retains one request key, fences new writes, and checks only on request", async () => {
  let writes = 0;
  const keys: unknown[] = [];
  const model = createNeedAuthor({
    deal: id,
    client,
    changed() {},
    call: async (verb, args) => {
      if (verb.startsWith("read")) return page();
      keys.push(args.idempotency_key);
      if (++writes === 1) throw Error("lost");
      return { schema_version: "client-needs.v1", need: { ...need, state: "withdrawn", version: 2 } };
    },
  });
  await model.load();
  await model.withdraw(id);
  assert.equal(String(model.state.kind), "unknown");
  model.edit(id);
  await model.withdraw(id);
  assert.equal(writes, 1);
  await model.check();
  assert.deepEqual(keys, [keys[0], keys[0]]);
  assert.equal(model.rows[0]?.state, "withdrawn");
});
test("conflict requires reload and retired panels ignore late responses", async () => {
  let resolve: (v: unknown) => void = () => {};
  let conflict = true;
  const model = createNeedAuthor({
    deal: id,
    client,
    changed() {},
    call: async (verb) => {
      if (verb.startsWith("read")) return page();
      if (conflict) return { error: "version_conflict" };
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  await model.load();
  model.review(id);
  await model.approve();
  assert.equal(String(model.state.kind), "conflict");
  model.edit(id);
  assert.equal(String(model.state.kind), "conflict");
  await model.load();
  conflict = false;
  model.review(id);
  const pending = model.approve();
  model.retire();
  resolve({ schema_version: "client-needs.v1", need });
  await pending;
  assert.equal(String(model.state.kind), "retired");
  assert.deepEqual(model.rows, []);
});

test("vendor read excludes drafts, lapsed, withdrawn, restricted and stale needs", async () => {
  const { parseVendorNeeds } = await import("../src/ui/deal-client-needs-model.ts");
  const approved = {
    ...need,
    state: "approved",
    approved_revision: 1,
    approved_by: client,
    approved_at: "2026-11-11T00:00:00Z",
  };
  const response = { ...page(), subject: "vendor", rows: [approved] };
  assert.equal(parseVendorNeeds(response, id).rows.length, 1);
  for (const patch of [
    { state: "draft" },
    { state: "edited_lapsed" },
    { state: "withdrawn" },
    { state: "stale" },
    { restriction: "restricted" },
    { fresh_until: "2020-01-01T00:00:00Z" },
    { approved_revision: 2 },
    { identity_restricted: true },
  ])
    assert.throws(() => parseVendorNeeds({ ...response, rows: [{ ...approved, ...patch }] }, id));
});
test("new need creates once, pagination advances, unavailable reads reload and no write overlaps pending", async () => {
  let fail = true;
  const calls: Record<string, unknown>[] = [];
  let release: (value: unknown) => void = () => {};
  const model = createNeedAuthor({
    deal: id,
    client,
    changed() {},
    call: async (verb, args) => {
      calls.push(args);
      if (verb.startsWith("read")) {
        if (fail) throw Error("read");
        return { ...page(), next_offset: args.offset === 0 ? 50 : null };
      }
      return new Promise((r) => {
        release = r;
      });
    },
  });
  await model.load();
  assert.equal(String(model.state.kind), "unavailable");
  fail = false;
  await model.load();
  await model.load(true);
  assert.equal(calls[2]?.offset, 50);
  assert.equal(model.rows.length, 1, "Live pages keep one card per need identity");
  model.edit();
  const save = model.save({ ...need, vendor: id, withdrawn: false });
  assert.equal(String(model.state.kind), "pending");
  assert.equal(calls[3]?.base_version, undefined);
  await model.save({ ...need, vendor: id, withdrawn: false });
  model.review(id);
  await model.withdraw(id);
  assert.equal(calls.length, 4);
  release({ schema_version: "client-needs.v1", need });
  await save;
  assert.equal(String(model.state.kind), "listing");
  for (const variant of [
    { ...need, state: "withdrawn" as const },
    { ...need, restriction: "restricted" as const },
    { ...need, fresh_until: "2020-01-01T00:00:00Z" },
  ]) {
    const denied = createNeedAuthor({ deal: id, client, changed() {}, call: async () => page([variant]) });
    await denied.load();
    denied.review(id);
    assert.equal(denied.state.kind, "listing");
  }
});

for (const state of ["draft", "approved", "edited_lapsed", "stale", "withdrawn"])
  test(`saved ${state} evidence can be edited without automatic approval`, async () => {
    const row = { ...need, state };
    const verbs: string[] = [];
    const model = createNeedAuthor({
      deal: id,
      client,
      changed() {},
      call: async (verb, args) => {
        verbs.push(verb);
        if (verb.startsWith("read")) return page([row]);
        assert.equal(args.base_version, 1);
        return {
          schema_version: "client-needs.v1",
          need: { ...need, revision: 2, version: 2, state: "edited_lapsed" },
        };
      },
    });
    await model.load();
    model.edit(id);
    await model.save({ ...need, vendor: id, withdrawn: false });
    assert.equal(model.rows[0]?.state, "edited_lapsed");
    assert.deepEqual(verbs, ["read-deal-client-needs-v1", "record-deal-client-need-v1"]);
  });
for (const state of ["draft", "approved", "edited_lapsed", "stale"])
  test(`${state} need withdraws through its displayed version`, async () => {
    const model = createNeedAuthor({
      deal: id,
      client,
      changed() {},
      call: async (verb, args) => {
        if (verb.startsWith("read")) return page([{ ...need, state }]);
        assert.equal(args.need, id);
        assert.equal(args.base_version, 1);
        assert.ok(
          args.fields &&
            typeof args.fields === "object" &&
            "withdrawn" in args.fields &&
            args.fields.withdrawn === true,
        );
        return { schema_version: "client-needs.v1", need: { ...need, state: "withdrawn", version: 2 } };
      },
    });
    await model.load();
    await model.withdraw(id);
    assert.equal(model.rows[0]?.state, "withdrawn");
  });
for (const screen of ["listing", "editing", "reviewing", "pending", "unknown", "conflict"])
  test(`session retirement fences ${screen} and drops its private rows`, async () => {
    let release: (v: unknown) => void = () => {};
    let writes = 0;
    const model = createNeedAuthor({
      deal: id,
      client,
      changed() {},
      call: async (verb) => {
        if (verb.startsWith("read")) return page();
        ++writes;
        if (screen === "unknown") throw Error("lost");
        if (screen === "conflict") return { error: "version_conflict" };
        return new Promise((r) => {
          release = r;
        });
      },
    });
    await model.load();
    if (screen === "editing") {
      model.edit();
      model.cancel();
      model.edit(id);
    } else if (screen !== "listing") {
      model.review(id);
    }
    let pending: Promise<void> | undefined;
    if (["pending", "unknown", "conflict"].includes(screen)) {
      pending = model.approve();
      if (screen !== "pending") await pending;
    }
    assert.equal(String(model.state.kind), screen);
    model.retire();
    const count = writes;
    await model.load();
    model.edit();
    model.review(id);
    await model.approve();
    await model.check();
    await model.withdraw(id);
    assert.equal(writes, count);
    assert.deepEqual(model.rows, []);
    release({ schema_version: "client-needs.v1", need });
    await pending;
    assert.equal(String(model.state.kind), "retired");
  });
