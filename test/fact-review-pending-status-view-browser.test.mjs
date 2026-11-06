import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { readFile } from 'node:fs/promises';
import { observeOnPage } from '../scripts/prove-fact-review-pending-status-view.mjs';
const recordings = JSON.parse(await readFile(new URL('./fixtures/fact-review-pending-status-view/recordings.json', import.meta.url), 'utf8'));
for (const width of [390, 1440]) for (const colorScheme of ['light', 'dark']) {
  test(`status filter transitions and design invariants at ${width}px ${colorScheme}`, async t => {
    const server = await fixtureServer(); t.after(() => server.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    await page.goto(server.origin);
    const result = await observeOnPage(page, server.origin, recordings);
    assert.ok(result.assertions.includes('draft-text-and-form-identity-retained'));
    assert.ok(result.assertions.includes('disposed-late-response-ignored'));
  });
}

test('status controls are keyboard reachable and retain focus', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(server.origin);
  await page.evaluate(async ({ origin, recordings }) => {
    const { mountFactReview } = await import(`${origin}/js/ui-facts.js`);
    const { createLiveClient } = await import(`${origin}/js/live-client.js`);
    const { FACT_TERMS } = await import(`${origin}/js/client.js`);
    const client = createLiveClient({ fetchImpl: async (url, init) => {
      if (url === '/auth/session') return Response.json(recordings.session);
      const verb = JSON.parse(init.body).params.name;
      const payload = verb === 'list-fact-review' ? recordings.initial : recordings.documents;
      return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
    } });
    const root = document.body.appendChild(document.createElement('main'));
    window.statusPanel = mountFactReview(root, { client, entityRef: recordings.entity, terms: FACT_TERMS });
    await window.statusPanel.refresh();
  }, { origin: server.origin, recordings });
  const selector = page.getByLabel('Review status');
  await page.getByLabel('Filter by term').focus(); await page.keyboard.press('Tab');
  assert.equal(await selector.evaluate(node => node === document.activeElement), true);
  await selector.selectOption('pending');
  assert.equal(await selector.inputValue(), 'pending');
  assert.equal(await selector.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Clear status' }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.equal(await selector.inputValue(), '');
  await page.evaluate(() => window.statusPanel.dispose());
});
