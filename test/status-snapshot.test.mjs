import test from "node:test";
import assert from "node:assert/strict";
import { writeSnapshot } from "../js/status-model.js";

const snapshot = {
  schema: "doctorcre-status-snapshot.v1",
  saved_at: "2026-10-15T00:00:00.000Z",
  reads: [],
};

for (const [label, storage] of [["null", null], ["undefined", undefined], ["missing setter", {}]]) {
  test(`snapshot write returns false for ${label} storage`, () => {
    assert.equal(writeSnapshot(storage, snapshot), false);
  });
}

test("snapshot write calls the store and reports success", () => {
  const storage = {
    writes: [],
    setItem(key, value) { this.writes.push([key, value]); },
  };
  assert.equal(writeSnapshot(storage, snapshot), true);
  assert.deepEqual(storage.writes, [[
    "doctorcre.status-snapshot.v1",
    '{"schema":"doctorcre-status-snapshot.v1","saved_at":"2026-10-15T00:00:00.000Z","reads":[]}',
  ]]);
});

test("snapshot write returns false when the store refuses", () => {
  const storage = { setItem() { throw new Error("Synthetic storage refusal"); } };
  assert.equal(writeSnapshot(storage, snapshot), false);
});
