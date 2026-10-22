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
