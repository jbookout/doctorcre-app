import assert from "node:assert/strict";
import test from "node:test";
import { Ajv } from "ajv";
import { workingWeekResponses } from "./fixtures/home-working-week.ts";
import contract from "./fixtures/home-working-week-contract.json" with { type: "json" };

const validate = new Ajv().compile(contract);

test("working-week admission rejects the old fixture date and incomplete calendar rows", () => {
  const responses = workingWeekResponses("2026-11-11");
  assert.ok(validate(responses));
  const oldDate = structuredClone(responses);
  Object.assign(oldDate["read-home-agenda"].deals[0]?.critical_dates[0] || {}, {
    label: "Synthetic date",
    date: "2026-11-11",
  });
  assert.equal(validate(oldDate), false, "legacy FixtureClient fields are not producer fields");
  for (const field of ["id", "kind", "due_on", "note", "status"]) {
    const changed = JSON.parse(JSON.stringify(responses));
    delete changed["read-home-agenda"].deals[0].critical_dates[0][field];
    assert.equal(validate(changed), false, `agenda requires ${field}`);
  }
  for (const field of ["organizer", "attendees", "recurring", "times", "schedule_conflicts", "end"]) {
    const changed = JSON.parse(JSON.stringify(responses));
    delete changed["calendar-meeting-prep"].items[0][field];
    assert.equal(validate(changed), false, `calendar requires ${field}`);
  }
});
