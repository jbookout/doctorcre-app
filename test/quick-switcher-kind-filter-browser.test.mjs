import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { contractFixture, observeKindFilter } from '../scripts/prove-quick-switcher-kind-filter.mjs';
const server = await startFixtureServer();
test.after(server.stop);
for (const theme of ['light', 'dark']) for (const width of [390, 1440]) test(`kind filtering, query and keyboard at ${width} ${theme}`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    await page.goto(server.url);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await observeKindFilter(page, contractFixture());
    const bounds = await page.locator('[data-quick-switcher]').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    const input = page.getByRole('combobox', { name: 'Jump to', exact: true });
    await page.getByRole('group', { name: 'Destination kind' }).getByRole('button', { name: 'Contacts', exact: true }).click();
    await input.fill('Fixture Contact');
    await input.press('ArrowUp');
    await input.press('Enter');
    await page.waitForURL('**/relationships?node=party%3A22222222-2222-4222-8222-222222222222');
  } finally { await browser.close(); }
});
test('partial retry, removal, close, recents and late session disposal', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    const fixture = contractFixture();
    await page.evaluate(async fixture => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.js');
      window.payload = { ...fixture, network: null };
      window.reads = 0;
      window.openFixture = () => openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Fixture Page', href: '/calendar' }], read: () => { window.reads++; return window.held ? new Promise(resolve => window.resolveRead = resolve) : Promise.resolve(window.payload); } });
      window.openFixture();
    }, fixture);
    const kind = page.getByRole('group', { name: 'Destination kind' });
    const input = page.getByRole('combobox', { name: 'Jump to', exact: true });
    await kind.getByRole('button', { name: 'Deals', exact: true }).click();
    await page.getByRole('option').first().waitFor();
    await input.fill(' Fixture ');
    await input.press('ArrowDown');
    await page.evaluate(() => window.payload = { board: null, network: null });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByText('No matches. Try a deal, contact or page name.').waitFor();
    assert.equal(await input.getAttribute('aria-activedescendant'), null);
    assert.equal(await input.inputValue(), ' Fixture ');
    await page.evaluate(fixture => window.payload = fixture, fixture);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('option').first().waitFor();
    assert.equal(await input.getAttribute('aria-activedescendant'), 'quick-option-0');
    await input.press('Escape');
    assert.equal(await page.locator('.quick-switcher-toggle').evaluate(el => el === document.activeElement), true);
    await page.evaluate(() => { window.held = true; window.openFixture(); });
    assert.equal(await kind.getByRole('button', { name: 'All destinations' }).getAttribute('aria-pressed'), 'true');
    await kind.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
    await page.evaluate(fixture => window.resolveRead(fixture), fixture);
    assert.equal(await page.locator('[data-quick-switcher]').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')), null);
  } finally { await browser.close(); }
});
for (const mode of ['empty', 'contacts only', 'reject']) test(`${mode} keeps local filtering and reports counts`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    const payload = contractFixture();
    if (mode === 'empty') { payload.board.deals = []; payload.network.nodes = []; }
    if (mode === 'contacts only') payload.board = null;
    await page.evaluate(async ({ payload, mode }) => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.js');
      openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [], read: () => mode === 'reject' ? Promise.reject(Error('Unavailable')) : Promise.resolve(payload) });
    }, { payload, mode });
    const group = page.getByRole('group', { name: 'Destination kind' });
    await group.getByRole('button', { name: 'Contacts', exact: true }).click();
    if (mode === 'contacts only') {
      await page.getByRole('option', { name: 'Fixture Contact Contact' }).waitFor();
      await page.getByText('1 destinations', { exact: true }).waitFor();
    } else await page.getByText('No matches. Try a deal, contact or page name.').waitFor();
    await page.getByRole('combobox').press('Escape');
  } finally { await browser.close(); }
});
