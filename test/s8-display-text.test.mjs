import test from 'node:test';
import assert from 'node:assert/strict';
import { dealName } from '../js/pipeline-model.js';
import { shortDay } from '../js/calendar-model.js';

test('S8 a deal name stored as a structured value paints its text, never raw braces', () => {
  assert.equal(dealName('{"value":"E2E 1791335402563 json deal"}'), 'E2E 1791335402563 json deal');
  assert.equal(dealName('{"value":"Bay \\"Clinic\\" lease"}'), 'Bay "Clinic" lease');
  assert.equal(dealName('Westside MOB'), 'Westside MOB');
  assert.equal(dealName('  '), 'Untitled deal');
  assert.equal(dealName(null), 'Untitled deal');
});

test('S8 Today dates read as a short day, never a raw ISO timestamp', () => {
  assert.equal(shortDay('2026-10-08T00:00:00.000Z', '2026-10-18'), 'Oct 8');
  assert.equal(shortDay('2026-10-10', '2026-10-18'), 'Oct 10');
  assert.equal(shortDay('2027-01-04', '2026-10-18'), 'Jan 4, 2027');
  assert.equal(shortDay('Proposal', '2026-10-18'), 'Proposal');
  assert.equal(shortDay('', '2026-10-18'), '');
});
