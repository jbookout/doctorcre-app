import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeAge, sourceLine, sourceTime } from '../js/email-source-line.js';

// Local wall-clock times so the tests hold in any timezone.
const at = (month, date, hour = 9) => new Date(2026, month - 1, date, hour);

test('source line names the sender and age without an address', () => {
  const now = at(10, 28);
  assert.equal(sourceLine({ sender: 'Dana Demo <dana@example.test>', occurred_at: at(10, 28, 7).toISOString() }, now), "From Dana Demo's email, 2h ago");
  assert.equal(sourceLine({ sender: 'dana@example.test', occurred_at: at(10, 26).toISOString() }, now), 'From an email, 2d ago');
  assert.equal(sourceLine({ sender: null, occurred_at: null }, now), 'From an email, time unavailable');
});

test('ages cover minutes, hours, days and missing or future timestamps', () => {
  const now = new Date('2026-10-01T15:00:00Z');
  assert.equal(relativeAge('2026-10-01T14:58:00Z', now), '2m ago');
  assert.equal(relativeAge('2026-10-01T13:00:00Z', now), '2h ago');
  assert.equal(relativeAge('2026-09-29T15:00:00Z', now), '2d ago');
  assert.equal(relativeAge('2026-10-02T15:00:00Z', now), 'just now');
  assert.equal(relativeAge('bad timestamp', now), 'time unavailable');
});

test('absolute source time uses Chicago and omits the current year and timezone suffix', () => {
  const now = new Date('2026-10-01T15:00:00Z');
  assert.equal(sourceTime('2026-10-01T13:00:00Z', now), 'Oct 1, 8:00 AM');
  assert.equal(sourceTime('2025-10-01T13:00:00Z', now), 'Oct 1, 2025, 8:00 AM');
  assert.equal(sourceTime(null, now), 'Time unavailable');
});
