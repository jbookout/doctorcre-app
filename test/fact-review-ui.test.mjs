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

test('document pagination loads once and unavailable documents leave review usable', async () => {
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
  await panel.refresh();
  assert.equal(calls, 2);
  panel.dispose();
  client.listDealDocuments = async () => { throw new Error('unavailable'); };
  mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.textContent, /Stored documents unavailable/);
  assert.match(root.textContent, /Document name unavailable/);
  assert.equal(root.querySelector('[data-fact-record]'), null);
  assert.equal(root.querySelector('option[value=correct]').disabled, true);
});
