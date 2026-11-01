import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { meetingReviews, mountHomeMeetingReviews } from '../js/home-meeting-reviews.js';
import { createFixtureClient } from '../js/fixture-client.js';
import { carrInterface } from "./carr-contract.mjs";

const review = { key: 'a1b2c3d4e5f60718', title: 'Demo site tour', start: '2026-10-27T19:00:00+00:00', end: '2026-10-27T20:00:00+00:00',
  state: 'needs_review', prompt: 'Confirm whether this meeting happened.' };
const calendar = { state: 'partial', items: [], notes: [], follow_up_reviews: [review] };
const deals = [{ id: 'demo-other', name: 'Demo other deal', owner: 'dell' }, { id: 'demo-deal', name: 'Demo deal', owner: 'joe' }];
const ready = { calendar, deals, actor: 'joe', signedOut: false };
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)) };
}

function mount(logActivity = async () => ({ ok: true, activity_id: 'demo-activity' }), storage = memoryStorage()) {
  const dom = new JSDOM('<a id="homePrimaryAction" href="/deals">Deals</a><section id="reviews" hidden></section>');
  const host = dom.window.document.getElementById('reviews');
  const controller = mountHomeMeetingReviews({ document: dom.window.document, client: { logActivity }, host, storage,
    now: () => Date.parse('2026-10-28T12:00:00Z') });
  controller.update(ready);
  const choose = id => { const select = host.querySelector('select'); select.value = id; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  return { dom, host, controller, storage, choose, close() { controller.dispose(); dom.window.close(); } };
}

test('only well-formed reviews are listed, newest first', () => {
  const older = { ...review, key: '0000000000000001', end: '2026-10-27T19:30:00+00:00' };
  assert.deepEqual(meetingReviews({ follow_up_reviews: [older, review, { ...review, key: 'BAD' }, { ...review, key: 'ffffffffffffffff', state: 'done' },
    { ...review, key: 'eeeeeeeeeeeeeeee', end: review.start }] }).map(row => row.key), [review.key, older.key]);
  assert.deepEqual(meetingReviews({ items: [] }), []);
  assert.deepEqual(meetingReviews(null), []);
});

test('confirming a meeting logs one meeting activity on the chosen deal and hides it', async () => {
  const writes = [], h = mount(async args => { writes.push(args); return { ok: true, activity_id: 'demo-activity' }; });
  assert.equal(h.host.hidden, false);
  assert.equal(h.host.querySelector('.work-card-title')?.textContent, 'Demo site tour');
  assert.equal(h.host.querySelector('.work-card-status'), null);
  assert.match(h.host.textContent, /Did these meetings happen\?/);
  assert.deepEqual([...h.host.querySelectorAll('option')].map(o => o.value), ['', 'demo-deal', 'demo-other'], 'the partner’s own deals come first');
  assert.equal(h.host.querySelector('[data-review-log]').disabled, true, 'a deal must be chosen first');
  h.choose('demo-deal');
  h.host.querySelector('[data-review-log]').click();
  await settle();
  assert.equal(writes.length, 1);
  const { idempotency_key, ...args } = writes[0];
  assert.match(idempotency_key, /^[0-9a-f-]{36}$/);
  assert.deepEqual(args, { ref: 'demo-deal', kind: 'meeting', summary: 'Meeting: Demo site tour', occurred_at: '2026-10-27T19:00:00.000Z' });
  assert.equal(h.host.querySelector('[data-review]'), null);
  assert.match(h.host.textContent, /Meeting logged on Demo deal/);
  h.controller.update(ready);
  assert.equal(h.host.querySelector('[data-review]'), null, 'a logged meeting stays hidden on refresh');
  h.close();
});

test('dismissing hides the meeting without a write, and it stays hidden in this browser', async () => {
  const writes = [], storage = memoryStorage(), h = mount(async args => { writes.push(args); }, storage);
  h.host.querySelector('[data-review-dismiss]').click();
  assert.equal(h.host.hidden, true);
  assert.deepEqual(writes, []);
  h.close();
  const again = mount(async () => {}, storage);
  assert.equal(again.host.hidden, true);
  again.close();
});

test('an unanswered log keeps the same request and blocks dismissal until it is checked', async () => {
  const writes = [];
  const h = mount(async args => { writes.push(args); if (writes.length === 1) throw new TypeError('Synthetic response loss'); return { ok: true, activity_id: 'demo-activity' }; });
  h.choose('demo-deal');
  h.host.querySelector('[data-review-log]').click();
  await settle();
  assert.match(h.host.textContent, /Not confirmed yet/);
  assert.equal(h.host.querySelector('[data-review-dismiss]').disabled, true);
  assert.equal(h.host.querySelector('select').disabled, true);
  h.host.querySelector('[data-review-log]').click();
  await settle();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0], 'the retry replays the original request');
  assert.equal(h.host.querySelector('[data-review]'), null);
  h.close();
});

test('an unanswered log survives leaving Home: the next visit keeps the deal locked and replays the same request', async () => {
  const writes = [], storage = memoryStorage();
  const log = async args => { writes.push(args); if (writes.length === 1) throw new TypeError('Synthetic response loss'); return { ok: true, activity_id: 'demo-activity' }; };
  const h = mount(log, storage);
  h.choose('demo-deal');
  h.host.querySelector('[data-review-log]').click();
  await settle();
  assert.match(h.host.textContent, /Not confirmed yet/);
  h.close();
  const again = mount(log, storage);
  assert.match(again.host.textContent, /Not confirmed yet/);
  assert.equal(again.host.querySelector('select').value, 'demo-deal');
  assert.equal(again.host.querySelector('select').disabled, true);
  assert.equal(again.host.querySelector('[data-review-dismiss]').disabled, true);
  again.host.querySelector('[data-review-log]').click();
  await settle();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0], 'the next visit replays the original request and key');
  assert.equal(again.host.querySelector('[data-review]'), null);
  again.close();
  const third = mount(log, storage);
  assert.equal(third.host.hidden, true, 'a confirmed log stays handled');
  third.close();
});

test('a refused log after leaving Home frees the meeting for a new choice', async () => {
  const writes = [], storage = memoryStorage();
  const log = async args => { writes.push(args); if (writes.length === 1) throw new TypeError('Synthetic response loss'); if (writes.length === 2) throw Object.assign(Error('refused'), { payload: { error: 'not_a_deal' } }); return { ok: true, activity_id: 'demo-activity' }; };
  const h = mount(log, storage);
  h.choose('demo-deal');
  h.host.querySelector('[data-review-log]').click();
  await settle();
  h.close();
  const again = mount(log, storage);
  again.host.querySelector('[data-review-log]').click();
  await settle();
  assert.match(again.host.textContent, /The meeting was not logged/);
  again.close();
  const third = mount(log, storage);
  assert.equal(third.host.querySelector('select').disabled, false);
  third.choose('demo-other');
  third.host.querySelector('[data-review-log]').click();
  await settle();
  assert.equal(writes[2].ref, 'demo-other');
  assert.notEqual(writes[2].idempotency_key, writes[0].idempotency_key);
  third.close();
});

test('a refused log can be retried on another deal', async () => {
  const writes = [];
  const h = mount(async args => { writes.push(args); if (writes.length === 1) throw Object.assign(Error('refused'), { payload: { error: 'not_a_deal' } }); return { ok: true, activity_id: 'demo-activity' }; });
  h.choose('demo-deal');
  h.host.querySelector('[data-review-log]').click();
  await settle();
  assert.match(h.host.textContent, /The meeting was not logged/);
  h.choose('demo-other');
  h.host.querySelector('[data-review-log]').click();
  await settle();
  assert.equal(writes[1].ref, 'demo-other');
  assert.notEqual(writes[1].idempotency_key, writes[0].idempotency_key);
  h.close();
});

test('signing out or switching partner clears the card', () => {
  const h = mount();
  h.controller.update({ ...ready, signedOut: true });
  assert.equal(h.host.hidden, true);
  h.controller.update({ ...ready, actor: 'dell' });
  assert.equal(h.host.hidden, false);
  h.controller.update({ ...ready, calendar: null });
  assert.equal(h.host.hidden, true);
  h.close();
});

test('the fixture client logs a meeting on a known deal, and the verb is pinned', async () => {
  const seed = await readFile(new URL('../data/board-seed.json', import.meta.url));
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${seed.toString('base64')}` });
  const deal = (await client.getBoard()).deals[0];
  const args = { ref: deal.id, kind: 'meeting', summary: 'Meeting: Demo', occurred_at: '2026-10-27T19:00:00Z', idempotency_key: '00000000-0000-4000-8000-000000000001' };
  const receipt = await client.logActivity(args);
  assert.equal(receipt.ok, true);
  assert.deepEqual(await client.logActivity(args), receipt);
  const contract = carrInterface;
  assert.ok(contract.mcp_operations.includes('log-activity'));
});
