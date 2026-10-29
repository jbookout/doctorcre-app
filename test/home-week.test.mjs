import test from 'node:test';
import assert from 'node:assert/strict';
import { homeWeek } from '../js/home-week.js';

const agenda = { entries: [
  { key: 'task:undated', type: 'task', day: null, label: 'Synthetic social setup' },
  { key: 'task:due', type: 'task', day: '2026-11-01', label: 'Synthetic contract review', deal_id: 'synthetic-deal', deal_name: 'Synthetic practice' },
  { key: 'date:later', type: 'date', day: '2026-11-03', label: 'Synthetic lease date', deal_id: 'synthetic-deal' },
] };
const calendar = { state: 'ready', items: [
  { title: 'Synthetic second 1 AM', start: '2026-11-01T07:30:00Z', all_day: false, location: 'Synthetic conference room', attendee_count: 2 },
  { title: 'Synthetic first 1 AM', start: '2026-11-01T06:30:00Z', all_day: false, location: null, attendee_count: 1 },
  { title: 'Synthetic all-day event', start: '2026-11-02T00:00:00Z', all_day: true, attendee_count: 0 },
  { title: 'Synthetic previous day', start: '2026-11-01T04:30:00Z', all_day: false, attendee_count: 0 },
] };

test('Home week assigns dated work and orders repeated DST hours by their actual instant', () => {
  const days = homeWeek({ agenda, calendar, today: '2026-11-01' });
  assert.equal(days.length, 7);
  assert.equal(days[0].day, '2026-11-01');
  assert.deepEqual(days[0].dated.map(row => row.label), ['Synthetic contract review']);
  assert.notEqual(days[0].dated[0].time, 'All day');
  assert.deepEqual(days[0].timed.map(row => [row.label, row.time]), [
    ['Synthetic first 1 AM', '1:30 AM CDT'], ['Synthetic second 1 AM', '1:30 AM CST'],
  ]);
  assert.deepEqual(days[1].allDay.map(row => row.label), ['Synthetic all-day event']);
  assert.deepEqual(days[2].dated.map(row => row.label), ['Synthetic lease date']);
  assert.equal(JSON.stringify(days).includes('Synthetic social setup'), false);
  assert.equal(JSON.stringify(days).includes('Synthetic previous day'), false);
});

test('Home week retains partial meeting rows but never presents unavailable rows as current work', () => {
  const partial = homeWeek({ agenda, calendar: { ...calendar, state: 'partial' }, today: '2026-11-01' });
  assert.equal(partial[0].timed.length, 2);
  assert.deepEqual(partial[0].timed[1], {
    ...calendar.items[0], key: partial[0].timed[1].key, type: 'meeting', day: '2026-11-01',
    label: 'Synthetic second 1 AM', time: '1:30 AM CST',
  });
  for (const source of [null, { ...calendar, state: 'unavailable' }, { state: 'empty', items: [] }]) {
    const days = homeWeek({ agenda, calendar: source, today: '2026-11-01' });
    assert.equal(days.flatMap(day => day.timed).length, 0);
    assert.deepEqual(days[0].dated.map(row => row.label), ['Synthetic contract review']);
  }
});

test('Home week keeps cross-midnight meetings on the Chicago day across spring DST', () => {
  const days = homeWeek({ today: '2026-03-07', calendar: { state: 'ready', items: [
    { title: 'Synthetic after spring jump', start: '2026-03-08T08:05:00Z', all_day: false },
    { title: 'Synthetic before spring jump', start: '2026-03-08T07:30:00Z', all_day: false },
    { title: 'Synthetic late previous evening', start: '2026-03-08T05:30:00Z', all_day: false },
  ] } });
  assert.deepEqual(days[0].timed.map(row => [row.label, row.time]), [
    ['Synthetic late previous evening', '11:30 PM CST'],
  ]);
  assert.deepEqual(days[1].timed.map(row => [row.label, row.time]), [
    ['Synthetic before spring jump', '1:30 AM CST'], ['Synthetic after spring jump', '3:05 AM CDT'],
  ]);
});

test('Home week retains every coincident meeting and keeps their keys across unrelated source reordering', () => {
  const meeting = { title: 'Synthetic coincident meeting', start: '2026-11-01T06:30:00Z', all_day: false, attendee_count: 1 };
  const other = { title: 'Synthetic earlier meeting', start: '2026-11-01T05:30:00Z', all_day: false, attendee_count: 0 };
  const entries = items => homeWeek({ today: '2026-11-01', calendar: { state: 'ready', items } })[0].timed;
  const first = entries([meeting, other, { ...meeting }]);
  const reordered = entries([other, meeting, { ...meeting }]);
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map(row => row.key)).size, 3);
  assert.deepEqual(first.map(row => row.key), reordered.map(row => row.key));
});
