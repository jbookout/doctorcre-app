import test from 'node:test';
import assert from 'node:assert/strict';
import { morningBriefView } from '../js/morning-brief-model.js';

const now = new Date(2026, 9, 21, 8);
const options = { now, events: [], caughtUp: true };
const section = items => ({ state: items.length ? 'ready' : 'empty', items });

function producerBrief() {
  return {
    state: 'ready', sponsor: 'joe', observed_at: '2026-10-21T13:00:00.000Z',
    sections: {
      today: section([{
        item_kind: 'next_action', id: '00000000-0000-4000-8000-000000000001',
        subject_type: 'person', subject_id: '00000000-0000-4000-8000-000000000002',
        owner: 'joe-local', what: 'Confirm the example appointment',
        due_on: '2026-10-21T00:00:00.000Z', subject_name: 'Example Contact',
        subject_ref: 'P-EXAMPLE', business_days_overdue: 0, owner_partner: 'joe',
      }]),
      deals: section([]), loops: section([]),
      claim_card: section([]), renewals: section([]),
    },
  };
}

test('producer midnight action dates reach Do first with exact record identity', () => {
  const payload = producerBrief();
  const before = structuredClone(payload);
  const view = morningBriefView(payload, options);
  assert.deepEqual(view.groups.map(group => [group.key, group.row.id, group.row.due]), [
    ['first', '00000000-0000-4000-8000-000000000001', '2026-10-21'],
  ]);
  assert.equal(view.groups[0].row.action, payload.sections.today.items[0]);
  assert.deepEqual(payload, before);
});

test('producer loop dates and deal actions share calendar-day ordering', () => {
  const payload = producerBrief();
  payload.sections.today.items[0].subject_type = 'deal';
  payload.sections.deals = section([{
    id: payload.sections.today.items[0].subject_id, name: 'Example Deal',
    operating_state: 'active', phase: 'legal', owner: 'joe',
  }]);
  payload.sections.loops = section([{
    kind: 'open_loop', number: '7', status: 'open', title: 'Example earlier commitment',
    due_on: '2026-10-20T00:00:00.000Z', owner_partner: 'dell',
  }]);
  assert.deepEqual(morningBriefView(payload, options).groups.map(group => [group.row.kind, group.row.due]), [
    ['loop', '2026-10-20'], ['deal', '2026-10-21'],
  ]);
});

test('date-only and midnight dates agree while invalid, ambiguous and future days stay out', () => {
  for (const [value, count] of [
    ['2026-10-21', 1], ['2026-10-21T00:00:00+00:00', 1],
    ['2026-10-22T00:00:00.000Z', 0], ['2026-02-30', 0],
    ['2026-10-21T08:00:00Z', 0], ['2026-10-21T00:00:00-05:00', 0],
    [null, 0], ['not a date', 0],
  ]) {
    const payload = producerBrief();
    payload.sections.today.items[0].due_on = value;
    payload.sections.loops = section([{
      kind: 'open_loop', number: '7', status: 'open', title: 'Example commitment',
      due_on: value, owner_partner: 'dell',
    }]);
    const view = morningBriefView(payload, options);
    assert.equal(view.groups.length, count * 2, String(value));
    assert.ok(view.groups.every(group => group.row.due === '2026-10-21'));
  }
});
