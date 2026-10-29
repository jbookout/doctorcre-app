import test from 'node:test';
import assert from 'node:assert/strict';
import { businessDaysWaiting, waitingLabel, sourceLine } from '../js/email-source-line.js';

// Local wall-clock times so the tests hold in any timezone.
const at = (month, date, hour = 9) => new Date(2026, month - 1, date, hour);

test('business days count weekdays after the email date through today', () => {
  assert.equal(businessDaysWaiting(at(10, 26, 8).toISOString(), at(10, 26, 17)), 0); // Mon, same day
  assert.equal(businessDaysWaiting(at(10, 26).toISOString(), at(10, 27)), 1); // Mon -> Tue
  assert.equal(businessDaysWaiting(at(10, 26).toISOString(), at(10, 30)), 4); // Mon -> Fri
  assert.equal(businessDaysWaiting(at(10, 23).toISOString(), at(10, 26)), 1); // Fri -> Mon skips the weekend
  assert.equal(businessDaysWaiting(at(10, 24).toISOString(), at(10, 26)), 1); // Sat -> Mon
  assert.equal(businessDaysWaiting(at(10, 23).toISOString(), at(10, 25)), 0); // Fri -> Sun
  assert.equal(businessDaysWaiting(at(10, 16).toISOString(), at(10, 28)), 8); // Fri -> Wed of the week after next
  assert.equal(businessDaysWaiting(at(10, 28).toISOString(), at(10, 26)), 0); // future-dated email
  assert.equal(businessDaysWaiting('not a date', at(10, 26)), null);
  assert.equal(businessDaysWaiting(undefined, at(10, 26)), null);
});

test('waiting label reads Today, singular, plural, and weekend-only waits', () => {
  assert.equal(waitingLabel(at(10, 26, 8).toISOString(), at(10, 26, 17)), 'Today');
  assert.equal(waitingLabel(at(10, 26).toISOString(), at(10, 27)), 'Waiting 1 business day');
  assert.equal(waitingLabel(at(10, 26).toISOString(), at(10, 30)), 'Waiting 4 business days');
  assert.equal(waitingLabel(at(10, 23).toISOString(), at(10, 25)), 'Waiting since Friday');
  assert.equal(waitingLabel(null, at(10, 26)), '');
});

test('source line names the sender, subject and date and never shows an address', () => {
  const now = at(10, 28);
  assert.equal(sourceLine({ sender: 'Dana Demo', subject: 'Plan follow-up', occurred_at: at(10, 26).toISOString() }, now), 'From Dana Demo · Plan follow-up · Oct 26');
  assert.equal(sourceLine({ sender: 'Dana Demo <dana@example.test>', subject: 'Plan', occurred_at: at(10, 26).toISOString() }, now), 'From Dana Demo · Plan · Oct 26');
  assert.equal(sourceLine({ sender: 'dana@example.test', subject: 'Plan', occurred_at: at(10, 26).toISOString() }, now), 'Email · Plan · Oct 26');
  assert.equal(sourceLine({ sender: null, subject: '', occurred_at: null }, now), 'Email');
  assert.equal(sourceLine({ sender: 'Dana Demo', subject: 'Old note', occurred_at: at(12, 30).toISOString() }, new Date(2027, 0, 5)), 'From Dana Demo · Old note · Dec 30, 2026');
});
