import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { uiBundle } from '../scripts/ui-bundle.mjs';
import { observePagination } from '../scripts/prove-fact-document-pagination-disposal.mjs';
const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
const { mountFactReview } = await import('data:text/javascript;base64,' + bundle.toString('base64'));

test('document pagination lifecycle transitions', async () => {
  const dom = new JSDOM('<body></body>', { url: 'http://localhost', pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const result = await observePagination({ mountFactReview, document: dom.window.document });
    assert.ok(result.assertions.includes('disposed-first'));
    assert.equal(result.synthetic_write_calls, 0);
  } finally { dom.window.close(); }
});
