import test from 'node:test';
import assert from 'node:assert/strict';
import { briefWindow, composeMorningBrief, BRIEF_LIMIT } from '../js/morning-brief-model.js';

const now = new Date(2026, 9, 3, 8, 15);
const today = '2026-10-03';
const deal = (id, extra = {}) => ({ id, name: `Demo ${id}`, phase: 'Research', owner: 'joe', attention: false, next_step: null, next_date: null, operating_state: 'active', ...extra });
const board = deals => ({ actor: 'joe', deals });
const event = (id, subject_id, extra = {}) => ({ id, subject_type: 'deal', subject_id, actor: 'dell', verb: 'patch-deal-field', field: 'phase', old_value: 'Research', new_value: 'Legal', recorded_at: '2026-10-03T06:00:00.000Z', ...extra });
const since = '2026-10-02T22:00:00.000Z';

test('the first action is the oldest commitment the signed-in partner owns, and every line links to its record', () => {
  const brief = composeMorningBrief({
    board: board([deal('d1'), deal('d2'), deal('d3', { owner: 'dell' }), deal('d4', { attention: true, next_step: 'Call landlord' })]),
    triage: { items: [
      { subject_type: 'deal', subject_id: 'd2', subject_name: 'Demo d2', owner: 'joe', what: 'Send LOI', due_on: today },
      { subject_type: 'deal', subject_id: 'd1', subject_name: 'Demo d1', owner: 'joe', what: 'Review lease draft', due_on: '2026-09-30' },
      { subject_type: 'deal', subject_id: 'd3', subject_name: 'Demo d3', owner: 'dell', what: 'Partner task', due_on: '2026-09-29' },
      { subject_type: 'inbox', subject_id: 'm1', subject_name: 'Mail', owner: 'joe', what: 'Unlinked', due_on: '2026-09-28' },
    ] },
    events: [], since, now,
  });
  assert.equal(brief.name, 'Joe');
  assert.deepEqual({ ...brief.first }, { key: 'deal:d1', href: '/deals?deal=d1', name: 'Demo d1', text: 'Review lease draft', when: 'Overdue · Sep 30', tone: 'overdue' });
  assert.deepEqual(brief.today.map(item => [item.key, item.href, item.text, item.when]), [
    ['deal:d2', '/deals?deal=d2', 'Send LOI', 'Today'],
    ['deal:d4', '/deals?deal=d4', 'Call landlord', 'Flagged'],
  ]);
  for (const item of [brief.first, ...brief.today]) assert.match(item.href, /^\/deals\?deal=/);
});

test('overnight shows only changes after the boundary, by someone else, on boards the partner can see, one line per record', () => {
  const brief = composeMorningBrief({
    board: board([deal('d1'), deal('d2')]),
    triage: { items: [] },
    events: [
      event('e1', 'd1', { recorded_at: '2026-10-03T05:00:00.000Z', field: 'next_step', new_value: 'Older step' }),
      event('e2', 'd1', { recorded_at: '2026-10-03T06:30:00.000Z' }),
      event('e3', 'd2', { actor: 'joe' }),
      event('e4', 'd2', { recorded_at: '2026-10-02T20:00:00.000Z' }),
      event('e5', 'd9'),
    ],
    since, now,
  });
  assert.equal(brief.overnight.length, 1);
  const [line] = brief.overnight;
  assert.equal(line.key, 'deal:d1');
  assert.equal(line.href, '/deals?deal=d1');
  assert.equal(line.text, 'Phase → Legal');
  assert.match(line.when, /^Dell · \d{1,2}:\d{2} (AM|PM) · \+1$/);
});

test('empty sections are omitted, never padded, and an unavailable read stays distinct from empty', () => {
  const quiet = composeMorningBrief({ board: board([deal('d1')]), triage: { items: [] }, events: [], since, now });
  assert.equal(quiet.first, null);
  assert.deepEqual(quiet.today, []);
  assert.deepEqual(quiet.overnight, []);
  assert.equal(quiet.speech, 'Good morning, Joe.');
  const failed = composeMorningBrief({ board: board([deal('d1')]), triage: null, events: null, since, now });
  assert.equal(failed.today, null);
  assert.equal(failed.overnight, null);
  assert.equal(failed.first, null);
  assert.equal(composeMorningBrief({ board: null, triage: { items: [] }, events: [], since, now }), null);
  assert.equal(composeMorningBrief({ board: { deals: [] }, triage: { items: [] }, events: [], since, now }), null);
});

test('sections are bounded and the spoken brief stays near thirty seconds', () => {
  const deals = Array.from({ length: 9 }, (_, i) => deal(`d${i}`, { attention: true, next_step: `Follow up on the fictional premises requirement number ${i}` }));
  const brief = composeMorningBrief({ board: board(deals), triage: { items: [] }, events: deals.map((d, i) => event(`e${i}`, d.id)), since, now });
  assert.equal(brief.today.length, BRIEF_LIMIT);
  assert.equal(brief.overnight.length, BRIEF_LIMIT);
  assert.ok(brief.speech.split(/\s+/).length <= 75, brief.speech);
  assert.match(brief.speech, /^Good morning, Joe\. First, /);
});

test('the brief opens once per local day and keeps its overnight boundary when reopened', () => {
  const first = briefWindow(null, now);
  assert.equal(first.due, true);
  assert.equal(first.record.day, today);
  assert.equal(first.since, new Date(2026, 9, 2, 18, 0).toISOString());
  const again = briefWindow(first.record, new Date(2026, 9, 3, 15, 0));
  assert.equal(again.due, false);
  assert.equal(again.since, first.since);
  const tomorrow = briefWindow(first.record, new Date(2026, 9, 4, 7, 0));
  assert.equal(tomorrow.due, true);
  assert.equal(tomorrow.since, first.record.shownAt);
  assert.equal(briefWindow({ day: 'garbage' }, now).due, true);
});
