import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSearchResponse, SavedSearches } from "../src/ui/deal-space-search-model.ts";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/deal-space-searches/responses.json", import.meta.url), "utf8"),
);
test("recorded producer lifecycle responses cross the production parser", () => {
  for (const [key, response] of Object.entries(fixture)) {
    const rows = parseSearchResponse(response, fixture.saved.search.deal_id, key === "reopened");
    assert.equal(rows[0]?.id, fixture.saved.search.id);
  }
});
const deal = fixture.saved.search.deal_id;
function setup(responses: unknown[]) {
  const calls: { verb: string; args: Record<string, unknown> }[] = [];
  const model = new SavedSearches(
    deal,
    async (verb, args) => {
      calls.push({ verb, args });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    () => {},
  );
  return { model, calls };
}
test("idle, editing, saving, saved, reopen, archive and restore keep the deal criteria", async (t) => {
  t.mock.method(crypto, "randomUUID", () => fixture.saved.search.id);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(fixture.run.search.last_run_at) });
  const { model, calls } = setup([fixture.reopened, fixture.saved, fixture.archived, fixture.restored]);
  assert.equal(model.phase, "idle");
  await model.load();
  model.edit();
  assert.equal(model.phase, "editing");
  assert.ok(model.draft);
  model.update({ ...model.draft, name: "Medical space" });
  const saving = model.write("save");
  assert.equal(model.phase, "saving");
  await saving;
  assert.equal(model.phase, "saved");
  assert.equal(model.current?.id, fixture.saved.search.id);
  model.cancel();
  model.edit(fixture.run.search);
  assert.deepEqual(model.draft?.criteria, fixture.run.search.criteria);
  assert.equal(model.phase, "results-current");
  await model.write("archive");
  assert.equal(model.phase, "archived");
  await model.write("restore");
  assert.equal(model.phase, "restored");
  assert.equal(calls[2]?.args.status, "archived");
  assert.equal(calls[3]?.args.expected_version, 5);
});
test("run failure rolls back to previous results and retries the same idempotency key", async () => {
  const { model, calls } = setup([new Error("offline"), fixture.positive]);
  model.edit(fixture.run.search);
  const running = model.write("run");
  assert.equal(model.phase, "running");
  await running;
  assert.equal(model.phase, "run-failed");
  assert.deepEqual(model.current, fixture.run.search);
  await model.write("run");
  assert.deepEqual(model.current?.result_property_ids, fixture.positive.search.result_property_ids);
  assert.deepEqual([...model.newIds], fixture.positive.search.result_property_ids);
  assert.equal(calls[0]?.args.idempotency_key, calls[1]?.args.idempotency_key);
});
test("version conflict shows newer saved search while retaining draft requirements", async () => {
  const { model, calls } = setup([new Error("space_search_version_conflict"), fixture.reopened, fixture.stale]);
  model.edit(fixture.saved.search);
  assert.ok(model.draft);
  model.update({ ...model.draft, requirements: "Keep this draft" });
  await model.write("save");
  assert.equal(model.phase, "version-conflict");
  assert.equal(model.current?.version, 3);
  assert.equal(model.draft?.requirements, "Keep this draft");
  await model.write("save");
  assert.equal(calls[2]?.args.expected_version, 3);
  assert.notEqual(calls[0]?.args.idempotency_key, calls[2]?.args.idempotency_key);
});
test("current, stale and handed-to-cart preserve stable property identity", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(fixture.positive.search.last_run_at) });
  const { model } = setup([]);
  model.edit(fixture.positive.search);
  assert.equal(model.phase, "results-current");
  const id = fixture.positive.search.result_property_ids[0];
  model.toggle(id);
  let selected: string[] = [];
  model.handoff((ids) => {
    selected = ids;
    return true;
  });
  assert.deepEqual(selected, [id]);
  assert.equal(model.phase, "handed-to-cart");
  t.mock.timers.tick(86400000);
  assert.equal(model.stale(), true);
  model.handoff(() => {
    throw Error("Stale result handed to cart");
  });
  model.cancel();
  model.edit(fixture.stale.search);
  assert.equal(model.phase, "results-stale");
});
test("retired sessions reject late responses and all future writes", async () => {
  let release: (value: unknown) => void = () => {};
  let calls = 0;
  const model = new SavedSearches(
    deal,
    () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    () => {},
  );
  model.edit(fixture.saved.search);
  const pending = model.write("run");
  model.retire();
  release(fixture.positive);
  await pending;
  assert.equal(model.phase, "retired");
  assert.equal(model.current, null);
  await model.write("run");
  await model.load();
  assert.equal(calls, 1);
});
test("saved, stale, restored and handed results can rerun; saved briefs can archive", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(fixture.positive.search.last_run_at) });
  for (const row of [fixture.saved.search, fixture.stale.search, fixture.restored.search]) {
    const { model } = setup([fixture.positive]);
    model.edit(row);
    await model.write("run");
    assert.equal(model.phase, "results-current");
  }
  const { model } = setup([fixture.archived, fixture.restored, fixture.positive, fixture.positive]);
  model.edit(fixture.saved.search);
  await model.write("archive");
  assert.equal(model.phase, "archived");
  await model.write("restore");
  assert.equal(model.phase, "restored");
  await model.write("run");
  model.toggle(fixture.positive.search.result_property_ids[0]);
  model.handoff(() => true);
  assert.equal(model.phase, "handed-to-cart");
  await model.write("run");
  assert.equal(model.phase, "results-current");
});
test("two immediate run clicks issue one request and retirement prevents saving", async () => {
  let resolve: (value: unknown) => void = () => {};
  let calls = 0;
  const model = new SavedSearches(
    deal,
    async () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    () => {},
  );
  model.edit(fixture.saved.search);
  const pending = model.write("run");
  await model.write("run");
  assert.equal(calls, 1);
  resolve(fixture.positive);
  await pending;
  model.retire();
  await model.write("save");
  assert.equal(calls, 1);
});
test("rejects malformed responses and searches from another deal", () => {
  assert.throws(() => parseSearchResponse({ ...fixture.saved, schema_version: "wrong" }, fixture.saved.search.deal_id));
  assert.throws(() => parseSearchResponse(fixture.saved, crypto.randomUUID()));
  assert.throws(() =>
    parseSearchResponse(
      { ...fixture.saved, search: { ...fixture.saved.search, version: 0 } },
      fixture.saved.search.deal_id,
    ),
  );
});

test("boundary parser agrees with the pinned producer schema on malformed responses", async () => {
  const { Ajv } = await import("ajv");
  const schema = JSON.parse(
    await readFile(new URL("./fixtures/deal-space-searches/response-contract.json", import.meta.url), "utf8"),
  );
  const ajv = new Ajv({
    strict: false,
    formats: {
      uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "date-time": (value: string) => Number.isFinite(Date.parse(value)),
    },
  });
  for (const multiple of [false, true]) {
    const validate = ajv.compile(multiple ? schema.list : schema.one);
    const original = multiple ? fixture.reopened : fixture.positive;
    function compare(value: unknown) {
      const expected = validate(value);
      let actual = true;
      try {
        parseSearchResponse(value, deal, multiple);
      } catch {
        actual = false;
      }
      assert.equal(actual, expected, JSON.stringify(value));
    }
    function mutations(value: unknown, path: string[] = []) {
      if (!value || typeof value !== "object") return;
      for (const key of Object.keys(value)) {
        const child = Reflect.get(value, key);
        for (const replacement of [undefined, null, {}, [], true, -1, "invalid"]) {
          const changed = structuredClone(original);
          let parent = changed;
          for (const part of path) parent = parent[part];
          if (replacement === undefined) delete parent[key];
          else parent[key] = replacement;
          compare(changed);
        }
        mutations(child, [...path, key]);
      }
    }
    compare(original);
    mutations(original);
  }
});

test("departure guard follows idle, reading, edited and writing transitions", async () => {
  let settle: (value: unknown) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const model = new SavedSearches(
    deal,
    () =>
      new Promise((resolve, fail) => {
        settle = resolve;
        reject = fail;
      }),
    () => {},
  );
  assert.equal(model.blocksDeparture, false);
  const reading = model.load();
  assert.equal(model.working, true);
  assert.equal(model.blocksDeparture, false);
  settle(fixture.reopened);
  await reading;
  assert.equal(model.working, false);
  assert.equal(model.blocksDeparture, false);
  const failedRead = model.load();
  reject(Error("offline"));
  await failedRead;
  assert.equal(model.blocksDeparture, false);
  model.edit(fixture.saved.search);
  assert.ok(model.draft);
  model.update({ ...model.draft, name: "Unsaved name" });
  assert.equal(model.blocksDeparture, true);
  model.cancel();
  assert.equal(model.blocksDeparture, false);
  model.edit(fixture.saved.search);
  const running = model.write("run");
  assert.equal(model.dirty, false);
  assert.equal(model.blocksDeparture, true);
  settle(fixture.positive);
  await running;
  assert.equal(model.blocksDeparture, false);
  assert.ok(model.draft);
  model.update({ ...model.draft, name: "Unsaved name" });
  const failedSave = model.write("save");
  assert.equal(model.blocksDeparture, true);
  reject(Error("offline"));
  await failedSave;
  assert.equal(model.working, false);
  assert.equal(model.blocksDeparture, true);
  const saved = model.write("save");
  settle(fixture.saved);
  await saved;
  assert.equal(model.blocksDeparture, false);
});
