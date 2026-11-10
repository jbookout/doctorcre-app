import assert from "node:assert/strict";
import test from "node:test";
import { centralInstant, tomorrowCentral } from "../src/ui/central-time.ts";

test("Central return times retain winter, summer and midnight rollover behavior", () => {
  assert.equal(centralInstant("2026-01-15T09:00"), "2026-01-15T15:00:00.000Z");
  assert.equal(centralInstant("2026-07-15T09:00"), "2026-07-15T14:00:00.000Z");
  assert.equal(tomorrowCentral(new Date("2026-01-16T01:00:00Z")), "2026-01-16T09:00");
});

for (const value of ["invalid", "2026-02-30T09:00", "2026-03-08T02:30", "2026-11-01T01:30"]) {
  test(`Central return times reject invalid or ambiguous input ${value}`, () =>
    assert.throws(() => centralInstant(value)));
}
