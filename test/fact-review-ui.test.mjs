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
  mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14', attachments: client.attachments('d14') });
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
