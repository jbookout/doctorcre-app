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
