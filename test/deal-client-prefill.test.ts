import assert from "node:assert/strict";
import test from "node:test";
import { SavedSearches } from "../src/ui/deal-space-search-model.ts";

const deal = "11111111-1111-4111-8111-111111111111";
const client = "22222222-2222-4222-8222-222222222222";
const record = {
  id: client,
  name: "Synthetic Clinic",
  city: "Pensacola",
  state: "FL",
  vertical: "Dermatology",
  notes: "Need space next spring. Budget undecided.",
};
function setup() {
  let binding = client;
  let fail = false;
  const model = new SavedSearches(
    deal,
    async () => ({ deal_id: deal, client_id: binding }),
    () => {},
    async () => {
      if (fail) throw Error("offline");
      return record;
    },
  );
  model.edit();
  return {
    model,
    change: () => {
      binding = crypto.randomUUID();
    },
    fail: () => {
      fail = true;
    },
  };
}
test("review proposes exact context without changing the draft; apply only explicit choices", async () => {
  const { model } = setup();
  await model.reviewClient();
  assert.equal(model.draft?.name, "");
  assert.equal(model.sourceReview.kind, "review");
  if (model.sourceReview.kind !== "review") throw Error("No review");
  assert.equal(model.sourceReview.source.location, "Pensacola, FL");
  assert.equal(model.sourceReview.source.use, "Dermatology");
  model.chooseSource("name", "use");
  model.chooseSource("requirements", "use");
  await model.applySource();
  assert.equal(model.draft?.name, "Synthetic Clinic space search");
  assert.equal(model.draft?.requirements, record.notes);
  assert.equal(model.draft?.criteria.query, null);
  assert.equal(model.draft?.criteria.min_square_feet, null);
  assert.equal(model.draft?.client_prefill_source?.client_id, client);
});
test("refresh, failed read and keep choices preserve edited and deliberately cleared fields", async () => {
  const { model, fail } = setup();
  assert.ok(model.draft);
  model.update({ ...model.draft, name: "My search", requirements: "" });
  await model.reviewClient();
  model.chooseSource("name", "keep");
  model.chooseSource("requirements", "keep");
  await model.applySource();
  assert.equal(model.draft?.name, "My search");
  assert.equal(model.draft?.requirements, "");
  fail();
  await model.reviewClient();
  assert.equal(model.sourceReview.kind, "failed");
  assert.equal(model.draft?.name, "My search");
  assert.equal(model.draft?.requirements, "");
});
test("changed client invalidates choices and retirement rejects late reads", async () => {
  const { model, change } = setup();
  await model.reviewClient();
  model.chooseSource("name", "use");
  model.chooseSource("requirements", "use");
  change();
  await model.applySource();
  assert.equal(model.sourceReview.kind, "changed");
  assert.equal(model.draft?.name, "");
  const pending = model.reviewClient();
  model.retire();
  await pending;
  assert.equal(model.sourceReview.kind, "idle");
  assert.equal(model.draft, null);
});
test("editing after a choice requires another explicit field choice; cancellation discards proposals", async () => {
  const { model } = setup();
  await model.reviewClient();
  model.chooseSource("name", "use");
  model.chooseSource("requirements", "use");
  assert.ok(model.draft);
  model.update({ ...model.draft, requirements: "My newer edit" });
  await model.applySource();
  assert.equal(model.draft?.requirements, "My newer edit");
  model.cancel();
  model.edit();
  assert.equal(model.sourceReview.kind, "idle");
  assert.equal(model.draft?.client_prefill_source, null);
});

test("cancelling a pending detail read prevents it entering the next draft", async () => {
  let release: (value: unknown) => void = () => {};
  const model = new SavedSearches(
    deal,
    async () => ({ deal_id: deal, client_id: client }),
    () => {},
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  model.edit();
  const pending = model.reviewClient();
  await new Promise((resolve) => setImmediate(resolve));
  model.cancel();
  model.edit();
  release(record);
  await pending;
  assert.equal(model.sourceReview.kind, "idle");
  assert.equal(model.draft?.name, "");
});
test("malformed or wrong-client detail fails closed and retains edits", async () => {
  for (const invalid of [
    { ...record, id: deal },
    { ...record, notes: {} },
    { ...record, name: null },
  ]) {
    const model = new SavedSearches(
      deal,
      async () => ({ deal_id: deal, client_id: client }),
      () => {},
      async () => invalid,
    );
    model.edit();
    assert.ok(model.draft);
    model.update({ ...model.draft, requirements: "Keep" });
    await model.reviewClient();
    assert.equal(model.sourceReview.kind, "failed");
    assert.equal(model.draft?.requirements, "Keep");
  }
});

test("save conflict retains reviewed provenance; successful save and reopen never reapply source", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/deal-space-searches/responses.json", import.meta.url), "utf8"),
  );
  let saved = structuredClone(fixture.saved.search),
    conflict = true;
  const model = new SavedSearches(
    saved.deal_id,
    async (verb, args) => {
      if (verb === "get-deal-room") return { deal_id: saved.deal_id, client_id: client };
      if (verb === "read-deal-space-searches-v1") return { ...fixture.reopened, searches: [saved] };
      if (conflict) {
        conflict = false;
        throw Error("space_search_version_conflict");
      }
      saved = { ...saved, ...args, id: args.search_id, version: saved.version + 1 };
      delete saved.idempotency_key;
      delete saved.expected_version;
      delete saved.search_id;
      return { ...fixture.saved, search: saved };
    },
    () => {},
    async () => record,
  );
  model.edit(saved);
  await model.reviewClient();
  model.chooseSource("name", "use");
  model.chooseSource("requirements", "use");
  await model.applySource();
  const source = model.draft?.client_prefill_source;
  await model.write("save");
  assert.equal(model.phase, "version-conflict");
  assert.deepEqual(model.draft?.client_prefill_source, source);
  await model.write("save");
  assert.equal(model.phase, "saved");
  model.cancel();
  model.edit(saved);
  assert.deepEqual(model.draft?.client_prefill_source, source);
  assert.equal(model.sourceReview.kind, "idle");
  assert.equal(model.draft?.requirements, record.notes);
});
