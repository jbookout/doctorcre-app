import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';

const server = await startFixtureServer();
test.after(() => server.stop());

test('switcher keyboard, recents, navigation and phone control', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(server.url);
    const opener = page.getByRole('button', { name: 'Quick switcher' });
    await opener.click();
    const input = page.getByRole('combobox', { name: 'Jump to' });
    await input.fill('demo');
    await page.getByRole('option').filter({ hasText: 'Contact' }).first().waitFor();
    await page.getByRole('option').filter({ hasText: 'Deal' }).first().waitFor();
    await input.fill('zzzz-no-match');
    await page.getByText('No matches. Try a deal, contact or page name.').waitFor();
    await input.fill('calendar');
    await input.press('ArrowDown');
    assert.ok(await input.getAttribute('aria-activedescendant'));
    await input.press('Escape');
    assert.equal(await opener.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Control+k');
    await input.fill('calendar');
    await input.press('Enter');
    await page.waitForURL('**/calendar');
    await page.keyboard.press('Meta+k');
    await page.getByRole('heading', { name: 'Recent', exact: true }).waitFor();
    await page.getByRole('option', { name: 'Calendar Page' }).click();
    await page.waitForURL('**/calendar');
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.id = 'fixtureParent';
      const input = document.createElement('input');
      input.setAttribute('aria-label', 'Parent field');
      dialog.append(input);
      document.body.append(dialog);
      dialog.showModal();
      input.focus();
    });
    await page.keyboard.press('Control+k');
    await input.waitFor();
    await input.press('Escape');
    assert.equal(await page.getByRole('textbox', { name: 'Parent field' }).evaluate(el => el === document.activeElement), true);
    await page.evaluate(() => document.getElementById('fixtureParent').remove());
  } finally { await browser.close(); }
});

test('switcher matrix is accessible in both themes', async () => {
  const browser = await chromium.launch();
  mkdirSync('out/test-artifacts/quick-switcher', { recursive: true });
  try {
    for (const width of [390, 1024, 1440]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
      await page.goto(server.url);
      await page.locator('#homeRoot[data-home-ready]').waitFor();
      await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
      const homeViolations = await page.evaluate(async () => (await axe.run(document)).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
      assert.deepEqual(homeViolations, [], `closed Home ${width} ${theme}`);
      await page.screenshot({ path: `out/test-artifacts/quick-switcher/${width}-${theme}-closed.png`, fullPage: true });
      await page.getByRole('button', { name: 'Quick switcher' }).click();
      await page.getByRole('combobox', { name: 'Jump to' }).fill('demo');
      await page.getByRole('option').filter({ hasText: 'Contact' }).first().waitFor();
      const violations = await page.evaluate(async () => (await axe.run(document)).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
      assert.deepEqual(violations, [], `${width} ${theme}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.ok(await page.locator('[data-quick-switcher]').evaluate(dialog => dialog.getBoundingClientRect().width <= 580));
      await page.screenshot({ path: `out/test-artifacts/quick-switcher/${width}-${theme}.png`, fullPage: true });
      await page.close();
    }
  } finally { await browser.close(); }
});

test('loading, retry, access narrowing, outside close and session retirement', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(async () => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.js');
      sessionStorage.setItem('doctorcre.quick-switcher.recents.v1', JSON.stringify(['deal:forbidden', 'page:/calendar']));
      let attempt = 0;
      openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Calendar', href: '/calendar' }], read: async () => {
        attempt++;
        if (attempt === 1) throw Error('Unavailable');
        return { board: { deals: [{ id: 'allowed', name: 'Allowed deal', open_actions: [{ id: 'action-1', description: 'Call the lender' }] }] }, network: { nodes: [] } };
      } });
    });
    await page.getByText('Deals and contacts unavailable. Pages are still available.').waitFor();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    const input = page.getByRole('combobox');
    await input.fill('forbidden');
    await page.getByText('No matches. Try a deal, contact or page name.').waitFor();
    await input.fill('lender');
    await page.getByRole('option', { name: 'Call the lender · Allowed deal Task' }).waitFor();
    await input.fill('');
    await page.getByRole('heading', { name: 'Recent', exact: true }).waitFor();
    await page.mouse.click(5, 5);
    await page.getByRole('combobox').waitFor({ state: 'detached' });
    await page.evaluate(async () => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.js');
      openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [], read: () => new Promise(resolve => { window.finishSwitcherRead = resolve; }) });
    });
    await page.getByText('Loading accessible items…').waitFor();
    await input.press('Escape');
    await page.evaluate(() => window.finishSwitcherRead({ board: { deals: [] }, network: { nodes: [] } }));
    assert.equal(await page.getByRole('combobox').count(), 0);
    await page.getByRole('button', { name: 'Quick switcher' }).click();
    await input.waitFor();
    await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
    await input.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')), null);
    assert.equal(await page.getByRole('button', { name: 'Quick switcher' }).isDisabled(), true);
  } finally { await browser.close(); }
});

test('deal and contact choices navigate to the exact fixture records', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).click();
    await page.getByRole('combobox').fill('demo');
    const deal = page.getByRole('option').filter({ hasText: 'Deal' }).first();
    await deal.waitFor();
    const title = await deal.locator('span').textContent();
    await deal.click();
    await page.waitForURL('**/deals?deal=*');
    await page.locator('#panelTitle').filter({ hasText: title }).waitFor();
    await page.keyboard.press('Control+k');
    await page.getByRole('heading', { name: 'Recent', exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Jump to' }).fill('Demo Coastal Dental');
    await page.getByRole('option', { name: 'Demo Coastal Dental Contact', exact: true }).click();
    await page.waitForURL('**/relationships?node=party%3Ademo-client');
    await page.locator('[data-node="party:demo-client"]').first().waitFor();
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Jump to' }).waitFor();
    assert.equal(await page.locator('[data-quick-switcher] #docOpen').count(), 0);
    await page.getByRole('combobox', { name: 'Jump to' }).press('Escape');
    assert.equal(await page.locator('#docOpen').count(), 1);
  } finally { await browser.close(); }
});
