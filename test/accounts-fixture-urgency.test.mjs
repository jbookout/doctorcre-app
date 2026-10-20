import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureClient } from '../js/fixture-client.js';

// The first five seed rows become this fixture's account market deals.
const seed = { deals: [
  { id: 'demo-past', name: 'Demo Past', next_date: '2026-10-18', last_touch: '2026-10-01' },
  { id: 'demo-today', name: 'Demo Today', next_date: '2026-10-19', last_touch: '2026-10-18' },
  { id: 'demo-future', name: 'Demo Future', next_date: '2026-10-20', last_touch: '2026-10-18' },
  { id: 'demo-parked', name: 'Demo Parked', next_date: '2026-10-01', operating_state: 'parked' },
  { id: 'demo-invoiced', name: 'Demo Invoiced', next_date: '2026-10-01', invoiced_on: '2026-10-18' },
] };

test('fixture account urgency counts the same active uninvoiced deals as detail', async () => {
  const client = await createFixtureClient({ today: () => '2026-10-19', seedUrl: `data:application/json,${encodeURIComponent(JSON.stringify(seed))}` });
  const board = await client.getBoard();
  assert.equal(board.accounts[0].overdue_deals, 1, 'today, future, parked and invoiced dates are not overdue');
  assert.equal(board.accounts[0].open_deals, 3, 'invoiced and parked market deals are excluded');
  assert.equal(board.accounts[0].stale_deals, 1, 'the count follows market touch dates');
  const tomorrow = await createFixtureClient({ today: () => '2026-10-20', seedUrl: `data:application/json,${encodeURIComponent(JSON.stringify(seed))}` });
  assert.equal((await tomorrow.getBoard()).accounts[0].overdue_deals, 2, 'the aggregate follows the same date clock');
});
