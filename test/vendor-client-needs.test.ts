import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseClientNeeds } from "../src/ui/vendor-client-needs-client.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/client-needs/recorded.json", import.meta.url), "utf8"));
const query = { vendor: fixture.subject_id, offset: 0, limit: 5 };
test("recorded response preserves exact approved need and source", () => {
  assert.deepEqual(parseClientNeeds(fixture, query).rows, fixture.rows);
});
for (const [name, patch] of Object.entries({
  withdrawn: { state: "withdrawn" },
  stale: { fresh_until: "2020-01-01T00:00:00Z" },
  lapsed: { approved_revision: 2 },
  restricted: { identity_restricted: true },
  otherVendor: { vendor_id: "00000000-0000-4000-8000-000000000001" },
  missingSource: { source_revision: "" },
}))
  test(`rejects ${name} instead of inventing a match`, () => {
    assert.throws(() => parseClientNeeds({ ...fixture, rows: [{ ...fixture.rows[0], ...patch }] }, query));
  });
test("empty and missing approval remain distinct and reject concealed rows", () => {
  for (const state of ["empty", "missing_approval"]) {
    assert.equal(parseClientNeeds({ ...fixture, rows: [], state }, query).state, state);
    assert.throws(() => parseClientNeeds({ ...fixture, state }, query));
  }
});
test("refuses wrong subject and nonadvancing pagination", () => {
  assert.throws(() => parseClientNeeds({ ...fixture, subject: "deal" }, query));
  assert.throws(() => parseClientNeeds({ ...fixture, next_offset: 1 }, { ...query, offset: 1 }));
});
