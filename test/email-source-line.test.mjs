import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeAge, sourceTime, waitingDays } from '../js/email-source-line.js';

test('ages cover minutes, hours, days and missing or future timestamps', () => {
  const now = new Date('2026-10-01T15:00:00Z');
  assert.equal(relativeAge('2026-10-01T14:58:00Z', now), '2m ago');
  assert.equal(relativeAge('2026-10-01T13:00:00Z', now), '2h ago');
  assert.equal(relativeAge('2026-09-29T15:00:00Z', now), '2d ago');
  assert.equal(relativeAge('2026-10-02T15:00:00Z', now), 'just now');
  assert.equal(relativeAge('bad timestamp', now), 'time unavailable');
});

test('absolute source time uses Chicago and includes its timezone and omits the current year', () => {
  const now = new Date('2026-10-01T15:00:00Z');
  assert.equal(sourceTime('2026-10-01T13:00:00Z', now), 'Oct 1, 8:00 AM CDT');
  assert.equal(sourceTime('2025-10-01T13:00:00Z', now), 'Oct 1, 2025, 8:00 AM CDT');
  assert.equal(sourceTime(null, now), 'Time unavailable');
});

test('waiting age counts complete days without negative or invented ages', () => {
  const now = new Date('2026-10-01T15:00:00Z');
  assert.equal(waitingDays('2026-10-01T12:00:00Z', now), '0 days waiting');
  assert.equal(waitingDays('2026-09-30T12:00:00Z', now), '1 day waiting');
  assert.equal(waitingDays('2026-09-28T15:00:00Z', now), '3 days waiting');
  assert.equal(waitingDays('2026-10-02T15:00:00Z', now), '0 days waiting');
  assert.equal(waitingDays(null, now), 'Waiting time unavailable');
});
