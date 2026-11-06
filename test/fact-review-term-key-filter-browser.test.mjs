import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { readFile } from 'node:fs/promises';
import { observeOnPage } from '../scripts/prove-fact-review-term-key-filter.mjs';
const recordings = JSON.parse(await readFile(new URL('./fixtures/fact-review-term-key-filter/recordings.json', import.meta.url), 'utf8'));
for (const width of [390, 1440]) for (const colorScheme of ['light', 'dark']) {
  test(`term filter transitions and design invariants at ${width}px ${colorScheme}`, async t => {
    const server = await fixtureServer(); t.after(() => server.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    await page.goto(server.origin);
    const result = await observeOnPage(page, server.origin, recordings);
    assert.ok(result.assertions.includes('draft-text-and-form-identity-retained'));
    assert.ok(result.assertions.includes('disposed-late-response-ignored'));
  });
}
