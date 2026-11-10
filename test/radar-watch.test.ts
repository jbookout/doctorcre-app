import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv } from "ajv";
import { createWatchListReader } from "../src/ui/watches/client.ts";
import { parseWatch } from "../src/ui/watches/model.ts";
import { parseWatchPage, watchSummary } from "../src/ui/watches/radar-model.ts";
import { subjectWatchV2ResponseSchema } from "./fixtures/watches/producer-schema.ts";

const value: unknown = JSON.parse(await readFile(new URL("./fixtures/watches/recorded.json", import.meta.url), "utf8"));
const watch = parseWatch(value, { subject_type: "deal", subject_id: "3c8b7e16-50f8-40de-a757-bf9583df4dd2" });
assert.ok(watch);
const recorded = { watch };
const validate = new Ajv({ strict: false, validateFormats: false }).compile(subjectWatchV2ResponseSchema);
const lease = "a593ce5f-a245-432b-a829-329a7a461a34";
test("multiple leases share linked deal policy; unlinked lease never inherits it", () => {
  const watches = parseWatchPage({
    ok: true,
    schema_version: "subject-watch.v2",
    watches: [recorded.watch],
    has_more: false,
    next_cursor: null,
  }).watches;
  assert.equal(
    watchSummary(watches, lease, recorded.watch.subject_id),
    "Lease not watching · Linked deal watching · 30, 90 days before the lease date",
  );
  assert.equal(watchSummary(watches, lease, null), "Lease not watching");
  assert.equal(
    watchSummary(watches, "b593ce5f-a245-432b-a829-329a7a461a34", recorded.watch.subject_id),
    watchSummary(watches, lease, recorded.watch.subject_id),
  );
});
test("watch list refuses malformed, duplicate and incomplete pagination evidence", () => {
  const page = {
    ok: true,
    schema_version: "subject-watch.v2",
    watches: [recorded.watch],
    has_more: false,
    next_cursor: null,
  };
  assert.throws(() => parseWatchPage({ ...page, watches: [recorded.watch, recorded.watch] }));
  assert.throws(() => parseWatchPage({ ...page, has_more: true }));
  assert.throws(() => parseWatchPage({ ...page, watches: [{ ...recorded.watch, state: "active" }] }));
});

test("complete paged reads use the v2 producer contract and reject repeated pages or excessive fan-out", async () => {
  const response = {
    ok: true,
    schema_version: "subject-watch.v2",
    watches: [recorded.watch],
    has_more: false,
    next_cursor: null,
  };
  assert.equal(validate(response), true);
  const reader = createWatchListReader(async () => ({ kind: "payload", payload: response }));
  assert.deepEqual(await reader(new AbortController().signal), [recorded.watch]);
  let calls = 0;
  const looping = createWatchListReader(async () => {
    calls++;
    return { kind: "payload", payload: { ...response, has_more: true, next_cursor: recorded.watch.id } };
  });
  await assert.rejects(() => looping(new AbortController().signal));
  assert.equal(calls, 2);
  calls = 0;
  const capped = createWatchListReader(async () => {
    calls++;
    const id = `a593ce5f-a245-432b-a829-${String(calls).padStart(12, "0")}`;
    const entry = { ...recorded.watch, id, subject_id: id, baseline: { ...recorded.watch.baseline, subject_id: id } };
    const payload = { ...response, watches: [entry], has_more: true, next_cursor: id };
    assert.equal(validate(payload), true);
    return { kind: "payload", payload };
  });
  await assert.rejects(() => capped(new AbortController().signal));
  assert.equal(calls, 10);

  await assert.rejects(() =>
    createWatchListReader(async () => ({ kind: "authorization" }))(new AbortController().signal),
  );
});

test("overlapping direct and deal policies remain distinct sources without creating app alerts", () => {
  const direct = {
    ...recorded.watch,
    id: "b593ce5f-a245-432b-a829-329a7a461a34",
    subject_type: "lease" as const,
    subject_id: lease,
    state: "paused" as const,
    baseline: { ...recorded.watch.baseline, subject_type: "lease" as const, subject_id: lease },
  };
  const page = {
    ok: true,
    schema_version: "subject-watch.v2",
    watches: [recorded.watch, direct],
    has_more: false,
    next_cursor: null,
  };
  assert.equal(validate(page), true);
  assert.equal(
    watchSummary(parseWatchPage(page).watches, lease, recorded.watch.subject_id),
    "Lease paused · 30, 90 days before the lease date · Linked deal watching · 30, 90 days before the lease date",
  );
});
