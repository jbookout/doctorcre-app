import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
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
      return Promise.resolve(window.nextPayload ?? payload);
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

for (const payload of [{ board, network: null }, { board: null, network }, { board: null, network: null }]) test('Retry intersects recents and session invalidation clears records', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(() => sessionStorage.setItem('doctorcre.quick-switcher.recents.v1', JSON.stringify(['deal:d1', 'party:c1', 'deal:forbidden'])));
    await open(page, payload);
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    const labels = await page.getByRole('option').allTextContents();
    assert.equal(labels.includes('Valid DealDeal'), payload.board !== null);
    assert.equal(labels.includes('Valid ContactContact'), payload.network !== null);
    assert.equal(labels.some(label => label.includes('forbidden')), false);
    await page.evaluate(payload => { window.nextPayload = payload; }, { board, network });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    assert.equal(await page.evaluate(() => window.readCount), 2);
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('combobox').fill('Valid');
    assert.equal(await page.getByRole('option').count(), 3);
    await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
    assert.equal(await page.locator('[data-quick-switcher]').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')), null);
  } finally { await browser.close(); }
});
for (const close of ['Escape', 'invalidate']) test(`late completion after ${close} cannot publish or write history`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/deals?deal=d1', route => route.fulfill({ contentType: 'text/html', body: '<button class="quick-switcher-toggle">Quick switcher</button>' }));
    await page.goto(`${server.url}/deals?deal=d1`);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(() => sessionStorage.clear());
    await open(page, null, 'held');
    if (close === 'Escape') await page.getByRole('combobox').press('Escape');
    else await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
    await page.evaluate(payload => window.finishRead(payload), { board, network: null });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('[data-quick-switcher]').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')), null);
  } finally { await browser.close(); }
});
test('read rejection retries into full results and selection follows current results', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(async () => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.js');
      let count = 0;
      openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Valid Page', href: '/calendar' }], read: () => ++count === 1 ? Promise.reject(Error('Unavailable')) : new Promise(resolve => { window.finishRead = resolve; }) });
    });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Loading accessible items' }).waitFor();
    await page.getByRole('combobox').fill('Valid');
    await page.evaluate(payload => window.finishRead(payload), { board, network });
    await page.getByRole('option', { name: 'Valid Deal Deal', exact: true }).waitFor();
    assert.equal(await page.getByRole('combobox').getAttribute('aria-activedescendant'), 'quick-option-0');
    await page.getByRole('combobox').press('ArrowDown');
    await page.getByRole('combobox').fill('Valid Contact');
    await page.getByRole('combobox').press('Enter');
    await page.waitForURL('**/relationships?node=party%3Ac1');
  } finally { await browser.close(); }
});

for (const theme of ['light', 'dark']) for (const width of [390, 1440]) test(`partial results visible in ${theme} at ${width}px`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await open(page, { board, network: null });
    await page.getByRole('combobox').fill('Valid');
    await page.getByRole('option', { name: 'Valid Deal Deal', exact: true }).waitFor();
    const bounds = await page.locator('[data-quick-switcher]').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    mkdirSync('out/test-artifacts/quick-switcher-partial-read', { recursive: true });
    await page.screenshot({ path: `out/test-artifacts/quick-switcher-partial-read/${theme}-${width}.png` });
  } finally { await browser.close(); }
});
