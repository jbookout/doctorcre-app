import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
const server = await startFixtureServer();
test.after(() => server.stop());
const board = { deals: [{ id: 'd1', name: 'Valid Deal', open_actions: [{ id: 't1', description: 'Valid Task' }] }] };
const network = { nodes: [{ id: 'party:c1', name: 'Valid Contact', kind: 'contact' }] };
async function open(page, payload, mode = 'resolved') {
  await page.evaluate(async ({ payload, mode }) => {
    const { openQuickSwitcher } = await import('/js/ui-quick-switcher.js');
    window.readCount = 0;
    openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Calendar', href: '/calendar' }, { label: 'Deals', href: '/deals' }], read: () => {
      window.readCount++;
      if (mode === 'held') return new Promise(resolve => { window.finishRead = resolve; });
      if (mode === 'rejected') return Promise.reject(Error('Unavailable'));
      return Promise.resolve(payload);
    } });
  }, { payload, mode });
  await page.getByRole('combobox').waitFor();
}
for (const [name, payload, message, labels] of [
  ['partial-board', { board, network: { nodes: null } }, 'Contacts unavailable. Deals, tasks and pages are still available.', ['Valid DealDeal', 'Valid Task · Valid DealTask']],
  ['partial-contacts', { board: null, network }, 'Deals and tasks unavailable. Contacts and pages are still available.', ['Valid ContactContact']],
  ['pages-only', { board: null, network: null }, 'Deals and contacts unavailable. Pages are still available.', []],
  ['full', { board, network }, null, ['Valid DealDeal', 'Valid Task · Valid DealTask', 'Valid ContactContact']],
  ['malformed contact rejects whole section', { board, network: { nodes: [...network.nodes, { name: 'No identity', kind: 'contact' }] } }, 'Contacts unavailable. Deals, tasks and pages are still available.', ['Valid DealDeal', 'Valid Task · Valid DealTask']],
  ['malformed board rejects whole section', { board: { deals: [...board.deals, { name: 'No identity' }] }, network }, 'Deals and tasks unavailable. Contacts and pages are still available.', ['Valid ContactContact']],
  ['malformed task rejects whole board', { board: { deals: [{ ...board.deals[0], open_actions: [{ description: 'No identity' }] }] }, network }, 'Deals and tasks unavailable. Contacts and pages are still available.', ['Valid ContactContact']],
]) test(name, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await open(page, payload);
    if (message) await page.getByRole('status').filter({ hasText: message }).waitFor({ timeout: 2500 });
    else await page.getByRole('status').filter({ hasText: '2 destinations' }).waitFor();
    await page.getByRole('combobox').fill('Valid');
    assert.deepEqual(await page.getByRole('option').allTextContents(), labels);
    await page.getByRole('combobox').press('Escape');
    assert.equal(await page.locator('[data-quick-switcher]').count(), 0);
  } finally { await browser.close(); }
});
