import test from 'node:test';
import assert from 'node:assert/strict';
import { agendaSnapshot, dealHref } from '../js/home-dashboard-model.js';

test('Home keeps every open call action with its own owner, date and deal', () => {
  const board = { actor: 'joe', deals: [{ id: 'demo-deal', name: 'Demo clinic', owner: 'joe' }] };
  const action = (id, due_on, owner = 'joe') => ({ id, description: `Demo ${id}`, due_on, owner, status: 'open' });
  const details = new Map([['demo-deal', { critical_dates: [], next_actions: [
    action('undated', null, 'dell'), action('future', '2026-10-02'),
    action('today', '2026-10-01'), action('overdue', '2026-09-30'),
    action('also-undated', null), { ...action('done', null), status: 'done' },
  ] }]]);
  const agenda = agendaSnapshot(board, details, { today: '2026-10-01' });
  assert.deepEqual(agenda.upcoming.map(row => row.key), [
    'task:overdue', 'task:today', 'task:also-undated', 'task:undated', 'task:future',
  ]);
  const undated = agenda.entries.find(row => row.key === 'task:undated');
  assert.equal(undated.day, null);
  assert.equal(undated.owner, 'dell');
  assert.equal(undated.deal_name, 'Demo clinic');
  assert.equal(dealHref(undated.deal_id), '/deals?deal=demo-deal');
  assert.equal(agenda.week[0].entries.length, 1, 'undated actions never acquire a calendar day');
  assert.equal(agenda.undated.length, 0, 'an intentionally undated task is not a failed date read');
  assert.deepEqual(agendaSnapshot(board, details, { scope: 'mine', today: '2026-10-01' }).entries.map(row => row.key), [
    'task:overdue', 'task:today', 'task:also-undated', 'task:future',
  ]);
});
