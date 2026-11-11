import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { readFile } from 'node:fs/promises';
import { observeOnPage } from '../scripts/prove-fact-priority-focus.mjs';
const recordings = JSON.parse(await readFile(new URL('./fixtures/fact-priority-focus/recordings.json', import.meta.url), 'utf8'));
for (const width of [390, 1440]) for (const colorScheme of ['light', 'dark']) {
  test(`priority transitions at ${width}px ${colorScheme}`, async t => {
    const server = await fixtureServer(); t.after(() => server.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    await page.goto(server.origin);
    const result = await observeOnPage(page, server.origin, recordings);
    assert.ok(result.assertions.includes('priority-is-local'));
    assert.ok(result.assertions.includes('priority-lock-preserves-draft'));
  });
}

test('priority is keyboard reachable and Enter clears the selection', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(server.origin);
  await page.evaluate(async recordings => {
    const { mountFactReview } = await import('/js/ui-facts.generated.js');
    const { createLiveClient } = await import('/js/live-client.js');
    const { FACT_TERMS } = await import('/js/client.js');
    const client = createLiveClient({ fetchImpl: async (_url, init) => Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(JSON.parse(init.body).params.name === 'list-fact-review' ? recordings.initial : recordings.documents) }] } }) });
    const root = document.body.appendChild(document.createElement('main'));
    window.priorityPanel = mountFactReview(root, { client, entityRef: recordings.entity, terms: FACT_TERMS });
    await window.priorityPanel.refresh();
  }, recordings);
  const selector = page.getByLabel('Review priority');
  await page.getByRole('button', { name: 'Clear status', exact: true }).evaluate(node => { node.disabled = false; node.focus(); });
  await page.keyboard.press('Tab');
  assert.equal(await selector.evaluate(node => node === document.activeElement), true);
  await selector.selectOption('high');
  assert.equal(await selector.inputValue(), 'high');
  assert.equal(await selector.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Clear priority', exact: true }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter'); assert.equal(await selector.inputValue(), '');
  await page.evaluate(() => window.priorityPanel.dispose());
});
