import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv } from "ajv";
import { parseWatch } from "../src/ui/watches/model.ts";
import { subjectWatchV2ResponseSchema } from "./fixtures/watches/producer-schema.ts";

const fixture: unknown = JSON.parse(readFileSync(new URL("./fixtures/watches/recorded.json", import.meta.url), "utf8"));
const subject = { subject_type: "deal", subject_id: "3c8b7e16-50f8-40de-a757-bf9583df4dd2" } as const;
test("recorded producer response passes production parser field for field", () => {
  assert.equal(new Ajv({ strict: false, validateFormats: false }).compile(subjectWatchV2ResponseSchema)(fixture), true);
  assert.deepEqual(parseWatch(fixture, subject), Reflect.get(Object(fixture), "watch"));
});
test("malformed and wrong-target responses never become confirmed watch state", () => {
  for (const value of [
    null,
    {},
    { ok: true },
    {
      ...Object(fixture),
      watch: {
        ...Reflect.get(Object(fixture), "watch"),
        policy: { change_kinds: ["lease_threshold_crossed"], include_self_changes: true },
      },
    },
  ])
    assert.throws(() => parseWatch(value, subject));
  assert.throws(() => parseWatch(fixture, { ...subject, subject_id: "11111111-1111-4111-8111-111111111111" }));
});

test("every consumed watch field refuses malformed variants", () => {
  const watch = parseWatch(fixture, subject);
  assert.ok(watch);
  for (const patch of [
    { id: "bad" },
    { actor_id: null },
    { subject_id: "bad" },
    { subject_type: "contact" },
    { state: "active" },
    { lifecycle_version: 0 },
    { subscribed_at: "2026-02-30T10:00:00Z" },
    { baseline: { ...watch.baseline, version: 0 } },
    { policy: { ...watch.policy, lease_threshold_days: [-1] } },
    { policy: { ...watch.policy, lease_threshold_days: [7, 7] } },
    { policy: { ...watch.policy, change_kinds: ["unknown"] } },
    { policy: { ...watch.policy, include_self_changes: "yes" } },
    { unexpected: true },
  ]) {
    assert.throws(() => parseWatch({ ...Object(fixture), watch: { ...watch, ...patch } }, subject));
  }
  for (const patch of [
    { schema_version: "subject-watch.v1" },
    { rows_changed: 2 },
    { has_more: "yes" },
    { next_cursor: "bad" },
  ])
    assert.throws(() => parseWatch({ ...Object(fixture), ...patch }, subject));
});

for (const thresholds of [
  { lease_threshold_days: [3650, 0, 90] },
  { lease_threshold_months: [24, 12, 6, 0, 120] },
  { lease_threshold_days: [90, 0], lease_threshold_months: [24, 6] },
])
  test(`producer threshold units round-trip exactly ${JSON.stringify(thresholds)}`, () => {
    const watch = Reflect.get(Object(fixture), "watch");
    const policy = { change_kinds: ["lease_threshold_crossed"], include_self_changes: true, ...thresholds };
    const value = { ...Object(fixture), watch: { ...watch, policy } };
    assert.equal(new Ajv({ strict: false, validateFormats: false }).compile(subjectWatchV2ResponseSchema)(value), true);
    assert.deepEqual(parseWatch(value, subject)?.policy, policy);
  });

test("both producer threshold units refuse malformed lists", () => {
  const watch = Reflect.get(Object(fixture), "watch");
  for (const [field, maximum] of [["lease_threshold_days", 3650], ["lease_threshold_months", 120]] as const)
    for (const list of [[], [1, 1], [-1], [maximum + 1], [0.5], ["6"], null, Array.from({ length: 21 }, (_, i) => i)]) {
      const value = { ...Object(fixture), watch: { ...watch, policy: {
        change_kinds: ["lease_threshold_crossed"], include_self_changes: true, [field]: list,
      } } };
      assert.equal(new Ajv({ strict: false, validateFormats: false }).compile(subjectWatchV2ResponseSchema)(value), false);
      assert.throws(() => parseWatch(value, subject));
    }
});
