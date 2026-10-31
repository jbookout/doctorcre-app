import test from 'node:test';
import assert from 'node:assert/strict';
import { FACT_TERMS } from '../js/client.js';
import { JSDOM } from 'jsdom';
import { uiBundle } from '../scripts/ui-bundle.mjs';
import { readFile } from 'node:fs/promises';
const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
const { mountFactReview } = await import('data:text/javascript;base64,' + bundle.toString('base64'));
import { createFactReviewFixture } from '../data/fixtures/fact-review.mjs';

test('terms show how values were read and retain the review reason after a conflict', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.FormData = dom.window.FormData;
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  client.resolveFactReview = async () => { throw Object.assign(new Error('stale'), { payload: { error: 'version_conflict' } }); };
  mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(root.textContent, /OCR · verify/);
  assert.match(root.textContent, /\$24\/SF\/yr/);
  const form = root.querySelector('[data-fact-review]');
  form.elements.decision.value = 'reject';
  form.elements.decision.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  form.elements.reason.value = 'Keep this reason';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(root.querySelector('[data-fact-review] [name=reason]').value, 'Keep this reason');
});

test('terms use the deal document list for citations and source choices', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.FormData = dom.window.FormData;
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.textContent, /Demo Lease\.pdf/);
  assert.match(root.querySelector('[data-fact-record] select[name=document_ref]').textContent, /Demo Lease\.pdf.*2026/);
});

test('document refresh reloads paginated documents and unavailable documents leave review usable', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.FormData = dom.window.FormData;
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  const all = (await client.listDealDocuments({ deal_id: 'd14' })).documents;
  let calls = 0;
  client.listDealDocuments = async ({ cursor }) => {
    calls++;
    return { ok: true, schema_version: 'deal-documents.v1', documents: cursor ? all.slice(1) : all.slice(0, 1), has_more: !cursor, next_cursor: cursor ? null : 'next' };
  };
  const panel = mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.textContent, /Demo Amendment\.pdf/);
  all.push({ id: "new-document", display_name: "New Lease.pdf", stored_at: "2026-01-01" });
  await panel.refresh();
  assert.equal(calls, 4);
  assert.match(root.querySelector("[data-fact-record]").textContent, /New Lease\.pdf/);
  const input = root.querySelector('[data-fact-record] input[name=value]');
  input.value = '42';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  root.querySelector('[data-refresh-terms]').click();
  await panel.refresh();
  assert.equal(calls, 4);
  assert.equal(input.value, '42');
  panel.dispose();
  client.listDealDocuments = async () => { throw new Error('unavailable'); };
  mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.textContent, /Stored documents unavailable/);
  assert.match(root.textContent, /Document name unavailable/);
  assert.equal(root.querySelector('[data-fact-record]'), null);
  assert.equal(root.querySelector('option[value=correct]').disabled, true);
});

test('rent schedules show period values, OCR provenance, and human review', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  const list = client.listFactReview.bind(client);
  const field = (value, method = 'ocr') => ({ value, source: { page: 1, region_id: 'row-1', method } });
  client.listFactReview = async args => {
    const page = await list(args);
    page.items.push({ entity_ref: 'd14', fact_key: 'rent_schedule', canonical_version: 0, review_version: '0'.repeat(64), pending: true, priority: 'normal', reasons: ['human_review'], review_history: [], canonical_fact: null,
      observations: [{ id: 'schedule', method: 'ocr', confidence_tier: 'human_review', unit: 'schedule', source: { document_ref: '00000000-0000-4000-8000-000000000030', page_start: 1, page_end: 1, cited_text: 'Year 1 | $24 | NNN', cited_text_expires_at: '2099-01-01T00:00:00Z' }, value: [
        { start_month: field(1), end_month: field(12), rate: field('24'), unit: field('USD/SF/year'), expense_basis: field('nnn'), escalation_percent: field(null) },
        { start_month: field(13), end_month: field(24), rate: field('24.72'), unit: field('USD/SF/year'), expense_basis: field('nnn'), escalation_percent: field('3') },
      ] }] });
    return page;
  };
  mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const schedule = root.querySelector('[data-fact-key="rent_schedule"]');
  assert.ok(schedule.querySelector('table'));
  assert.match(schedule.textContent, /1.*12/s);
  assert.match(schedule.textContent, /\$24\.72\/SF\/yr/);
  assert.match(schedule.textContent, /3%/);
  assert.match(schedule.textContent, /NNN/);
  assert.match(schedule.textContent, /OCR · verify/);
  assert.match(schedule.textContent, /Human review required/);
  assert.equal((schedule.textContent.match(/OCR · verify/g) || []).length, 1);
  assert.match(schedule.textContent, /Year 1 \| \$24 \| NNN/);
  assert.doesNotMatch(schedule.textContent, /auto.*promot/i);
  assert.equal(schedule.querySelector('option[value=correct]').disabled, true);
});


test('abstentions explain OCR failures without offering an unavailable value', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  const list = client.listFactReview.bind(client);
  client.listFactReview = async args => {
    const page = await list(args);
    for (const [fact_key, reason] of [['rent_schedule', 'ocr_disagreement'], ['term_months', 'unsupported_ocr']]) {
      page.items = page.items.filter(item => item.fact_key !== fact_key);
      page.items.push({ entity_ref: 'd14', fact_key, canonical_version: 0, review_version: '0'.repeat(64), pending: true, priority: 'high', reasons: [reason], review_history: [], canonical_fact: null, observations: [], extraction_abstentions: [{ status: 'unreadable', reason }] });
    }
    return page;
  };
  mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const schedule = root.querySelector('[data-fact-key="rent_schedule"]');
  assert.match(schedule.textContent, /OCR disagreement/);
  assert.equal(schedule.querySelector('[name=decision]').value, 'reject');
  assert.match(root.querySelector('[data-fact-key="term_months"]').textContent, /OCR could not read this/);
});
