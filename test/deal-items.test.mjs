import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderDealAlert, renderDealItemDetail } from '../js/deal-items.js';

const deal = { id: 'synthetic-deal', short_name: "Dr. Demo's Sample Deal", next_step: 'A legacy paragraph that must not appear.',
  items: [
    { id: 'intro', title: 'Vendor Introductions', due_on: '2026-10-01', status: 'open', bullets: [] },
    { id: 'market', title: 'Prelim Market Study', due_on: null, status: 'open', bullets: [] },
    { id: 'etl', title: 'ETL not completed', due_on: null, status: 'open', bullets: [] },
    { id: 'done', title: 'Completed Item', status: 'done', bullets: [] },
  ] };

test('an alert contains only its short heading, Still needed, numbered open item titles and due chips', () => {
  const doc = new JSDOM(renderDealAlert(deal, { today: '2026-10-22' })).window.document;
  assert.equal(doc.querySelector('h3').textContent, "Dr. Demo's Sample Deal");
  assert.equal(doc.querySelector('p').textContent, 'Still needed:');
  assert.deepEqual([...doc.querySelectorAll('ol li a')].map(n => n.textContent), ['Vendor Introductions', 'Prelim Market Study', 'ETL not completed']);
  assert.equal(doc.querySelector('ol a').getAttribute('href'), '/deals?deal=synthetic-deal&item=intro');
  assert.equal(doc.querySelector('time').getAttribute('datetime'), '2026-10-01');
  assert.ok(doc.querySelector('[data-overdue="true"]'));
  assert.doesNotMatch(doc.body.textContent, /legacy|Completed Item|Overdue|Joe|Research/);
});


test('item detail uses dated fact bullets and offers instruction and completion for that item', () => {
  const item = { ...deal.items[0], source_ref: 'capture:synthetic', bullets: [
    { date: '2026-09-11', kind: 'promised', text: 'Introduce a lender.' },
    { date: null, kind: 'call', text: 'Purchase discussed.' },
    { date: null, kind: 'suggestion', text: 'Arrange the introduction.' },
    { date: '2026-10-01', kind: 'status', text: 'Awaiting introduction.' },
  ] };
  const doc = new JSDOM(renderDealItemDetail(item)).window.document;
  assert.deepEqual([...doc.querySelectorAll('section h3')].map(n => n.textContent), ['What was promised', 'From the call', 'Suggested next steps', 'Status']);
  assert.equal(doc.querySelector('section li').textContent, '2026-09-11 · Introduce a lender.');
  assert.equal(doc.querySelectorAll('section p').length, 0);
  assert.equal(doc.querySelector('textarea').getAttribute('aria-label'), 'Tell Dr. CRE');
  assert.equal(doc.querySelector('[data-complete-item]').textContent, 'Mark done');
  assert.equal(doc.querySelectorAll('time').length, 3);
});

test('attention follows open item deadlines and clears when the last overdue item is done', async () => {
  const { needsAttention } = await import('../js/deal-review-model.js');
  const row = { ...deal, next_date: '2020-01-01' };
  const now = Date.parse('2026-10-22T15:00:00Z');
  assert.equal(needsAttention(row, now), true);
  assert.equal(needsAttention({ ...row, items: row.items.map(item => ({ ...item, status: 'done' })) }, now), false);
  assert.equal(needsAttention({ ...row, items: [] }, now), false);
});


test('the item sheet keeps the overdue date visible as a due chip', () => {
  const doc = new JSDOM(renderDealItemDetail(deal.items[0], { today: '2026-10-22' })).window.document;
  assert.match(doc.querySelector('.deal-item-date').textContent, /Overdue/);
  assert.equal(doc.querySelector('.deal-item-date[data-overdue="true"] time').getAttribute('datetime'), '2026-10-01');
});


test('the instruction input accepts only the length supported by the record verb', async () => {
  const { readFile } = await import('node:fs/promises');
  const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1.json', import.meta.url), 'utf8'));
  const doc = new JSDOM(renderDealItemDetail(deal.items[0])).window.document;
  assert.equal(doc.querySelector('textarea').maxLength, contract.mcp_write_contracts['instruct-deal-item'].inputSchema.properties.text.maxLength);
});

test('an empty structured item list states the gap without restoring legacy prose', () => {
  const doc = new JSDOM(renderDealAlert({ ...deal, items: [] })).window.document;
  assert.match(doc.body.textContent, /No action items recorded/);
  assert.doesNotMatch(doc.body.textContent, /legacy paragraph/);
});

test('an overdue alert states how many days it is overdue', () => {
  const one = new JSDOM(renderDealAlert({ ...deal, overdue_since: '2026-10-21' }, { today: '2026-10-22' })).window.document;
  assert.equal(one.querySelector('.deal-overdue').textContent, '1 day overdue');
  const many = new JSDOM(renderDealAlert({ ...deal, overdue_since: '2026-10-01' }, { today: '2026-10-22' })).window.document;
  assert.equal(many.querySelector('.deal-overdue').textContent, '21 days overdue');
});

test('board summaries use the real fixture and live adapters for detail-only actions and recorded steps', async () => {
  const { createFixtureClient } = await import('../js/fixture-client.js');
  const { createLiveClient } = await import('../js/live-client.js');
  const { readFile } = await import('node:fs/promises');
  const seed = JSON.parse(await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8'));
  Object.assign(seed.deals[0], { next_step: '', next_date: null, email_actions: [
    { id: 'later', status: 'open', owner: 'joe', description: 'Call the lender', due_on: '2026-10-30' },
    { id: 'earlier', status: 'open', owner: 'dell', description: 'Tour the property', due_on: '2026-10-12' },
    { id: 'done', status: 'done', owner: 'joe', description: 'Old action', due_on: '2026-10-01' },
  ] });
  seed.history = { [seed.deals[0].id]: [
    { id: 'old', summary: 'Sent the proposal', recorded_at: '2026-10-20T10:00:00Z' },
    { id: 'new', summary: 'Met the client', recorded_at: '2026-10-22T10:00:00Z' },
  ] };
  const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(seed)).toString('base64')}`, docContext: false });
  const detail = await fixture.getDeal(seed.deals[0].id);
  assert.equal(detail.next_actions[1].description, 'Tour the property');
  const board = await fixture.getBoard();
  assert.equal(board.schema_version, 'local-deals-board.v2');
  const row = board.deals.find(row => row.id === seed.deals[0].id);
  assert.deepEqual(row.open_actions, [
    { id: 'earlier', owner: 'dell', description: 'Tour the property', due_on: '2026-10-12' },
    { id: 'later', owner: 'joe', description: 'Call the lender', due_on: '2026-10-30' },
  ]);
  assert.deepEqual(row.last_step, { kind: 'note', summary: 'Met the client', occurred_at: '2026-10-22T10:00:00Z' });
  const live = createLiveClient({ fetchImpl: async () => Response.json({ result: { content: [{ text: JSON.stringify(board) }] } }) });
  for (const client of [fixture, live]) {
    const deal = (await client.getBoard()).deals.find(row => row.id === seed.deals[0].id);
    const doc = new JSDOM(renderDealAlert(deal, { today: '2026-10-29', viewer: 'joe', buttons: true, board: true })).window.document;
    assert.match(doc.body.textContent, /Next: Tour the property Dell/);
    assert.match(doc.body.textContent, /Last: Met the client Thu Oct 22/);
    assert.doesNotMatch(doc.body.textContent, /Old action|No next step/);
  }
  seed.deals[0].email_actions[2].completed_at = '2026-10-23T12:00:00Z';
  seed.deals[0].email_actions[2].outcome = 'Proposal accepted';
  const completedClient = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(seed)).toString('base64')}`, docContext: false });
  const completed = (await completedClient.getBoard()).deals.find(row => row.id === seed.deals[0].id);
  assert.deepEqual(completed.last_step, { kind: 'completed_action', summary: 'Proposal accepted', occurred_at: '2026-10-23T12:00:00Z' });

});

test('field audit writes preserve the recorded Last step and stay off board cards', async () => {
  const { createFixtureClient } = await import('../js/fixture-client.js');
  const { readFile } = await import('node:fs/promises');
  const seed = JSON.parse(await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8'));
  seed.history = { d14: [{ id: 'recorded-note', actor: 'joe', summary: 'Met the client', recorded_at: '2026-10-22T10:00:00Z' }] };
  const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(seed)).toString('base64')}`, docContext: false });
  const before = (await fixture.getBoard()).deals.find(row => row.id === 'd14');
  const result = await fixture.patchDealField({ deal: 'd14', field: 'attention', value: !before.attention,
    base_event_id: null, idempotency_key: 'board-field-audit' });
  assert.equal(result.status, 'ok');
  const after = (await fixture.getBoard()).deals.find(row => row.id === 'd14');
  assert.equal(after.attention, !before.attention);
  assert.deepEqual(after.last_step, before.last_step);
  const detail = await fixture.getDeal('d14');
  assert.ok(detail.history.some(entry => /attention/.test(entry.summary)));
  assert.ok(detail.activities.every(entry => !/attention/.test(entry.summary)));
  const doc = new JSDOM(renderDealAlert(after, { board: true, today: '2026-10-29' })).window.document;
  assert.match(doc.body.textContent, /Last: Met the client Thu Oct 22/);
  assert.doesNotMatch(doc.body.textContent, /attention|false|true/);
});

test('a field edit date never becomes a recorded last step', () => {
  const doc = new JSDOM(renderDealAlert({ id: 'empty', last_touch: '2026-10-22' }, { board: true })).window.document;
  assert.match(doc.body.textContent, /No next step set/);
  assert.doesNotMatch(doc.body.textContent, /Last:|Contact recorded/);
});

test('board summaries state a repeated action and its due date only once', () => {
  const row = { id: 'demo', open_actions: [{ id: 'action', description: 'Review sample documents', due_on: '2026-10-12', owner: 'joe' }],
    items: [{ id: 'item', title: 'Review sample documents', due_on: '2026-10-12', status: 'open' }] };
  const doc = new JSDOM(renderDealAlert(row, { board: true, today: '2026-10-01' })).window.document;
  assert.equal(doc.body.textContent.match(/Review sample documents/g).length, 1);
  assert.equal(doc.querySelectorAll('time').length, 1);
  assert.doesNotMatch(doc.body.textContent, /Still needed/);
});
