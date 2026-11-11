import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';

const server = await startFixtureServer();
test.after(() => server.stop());

for (const modifier of ['Meta', 'Control']) test(`${modifier}-Alt-K opens the global switcher`, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(server.url);
    const opener = page.getByRole('button', { name: 'Quick switcher' });
    await opener.waitFor();
    assert.equal(await opener.getAttribute('title'), 'Quick switcher (⌘/Ctrl+Alt+K)');
    assert.equal(await opener.getAttribute('aria-keyshortcuts'), 'Meta+Alt+K Control+Alt+K');
    await page.keyboard.press(`${modifier}+Alt+k`);
    const input = page.getByRole('combobox', { name: 'Jump to' });
    await input.waitFor({ timeout: 2000 });
    await input.press('Escape');
    await page.evaluate(modifier => dispatchEvent(new KeyboardEvent('keydown', {
      key: '˚', code: 'KeyK', altKey: true, metaKey: modifier === 'Meta',
      ctrlKey: modifier === 'Control', bubbles: true, cancelable: true,
    })), modifier);
    await input.waitFor({ timeout: 2000 });
  } finally { await browser.close(); }
});

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
    await page.keyboard.press('Control+Alt+k');
    await input.fill('calendar');
    await input.press('Enter');
    await page.waitForURL('**/calendar');
    await page.goto(`${server.url}/calendar?day=2026-11-03`);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.keyboard.press('Meta+Alt+k');
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
    await page.keyboard.press('Control+Alt+k');
    assert.equal(await input.count(), 0);
    await page.keyboard.press('Meta+Alt+k');
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
      await page.locator('#appCalendarSlot .calendar-panel').waitFor({ state: 'attached' });
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
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.generated.js');
      sessionStorage.setItem('doctorcre.quick-switcher.recents.v1', JSON.stringify(['deal:forbidden', 'page:/calendar']));
      let attempt = 0;
      openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Calendar', href: '/calendar' }], read: async () => {
        attempt++;
        if (attempt === 1) throw Error('Unavailable');
        return { board: { deals: [{ id: 'allowed', name: 'Allowed deal', open_actions: [{ id: 'action-1', item_id: 'next_action:33333333-3333-4333-8333-333333333333', description: 'Call the lender' }] }], closed_deals: [{ id: 'closed', name: 'Closed deal' }], lost_deals: [{ id: 'closed', name: 'Closed deal' }] }, network: { nodes: [] } };
      } });
    });
    await page.getByText('Deals and contacts unavailable. Pages are still available.').waitFor();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    const input = page.getByRole('combobox');
    await input.fill('forbidden');
    await page.getByText('No matches. Try a deal, contact or page name.').waitFor();
    await input.fill('lender');
    await page.getByRole('option', { name: 'Call the lender · Allowed deal Task' }).waitFor();
    await input.fill('Closed deal');
    await page.getByRole('option', { name: 'Closed deal Deal', exact: true }).waitFor();
    assert.equal(await page.getByRole('option').count(), 1);
    await input.fill('');
    await page.getByRole('heading', { name: 'Recent', exact: true }).waitFor();
    await page.mouse.click(5, 5);
    await page.getByRole('combobox').waitFor({ state: 'detached' });
    await page.evaluate(async () => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.generated.js');
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
    await page.keyboard.press('Control+Alt+k');
    await page.getByRole('heading', { name: 'Recent', exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Jump to' }).fill('Demo Coastal Dental');
    await page.getByRole('option', { name: 'Demo Coastal Dental Contact', exact: true }).click();
    await page.waitForURL('**/relationships?node=party%3Ademo-client');
    await page.locator('[data-node="party:demo-client"]').first().waitFor();
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.keyboard.press('Control+Alt+k');
    await page.getByRole('combobox', { name: 'Jump to' }).waitFor();
    assert.equal(await page.locator('[data-quick-switcher] #docOpen').count(), 0);
    await page.getByRole('combobox', { name: 'Jump to' }).press('Escape');
    assert.equal(await page.locator('#docOpen').count(), 1);
  } finally { await browser.close(); }
});

for (const variant of ['AltGraph', 'printable input', 'printable textarea', 'printable contenteditable', 'composing', '229']) test(`global switcher preserves ${variant} text entry`, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    const result = await page.evaluate(variant => {
      const field = document.createElement(variant.includes('textarea') ? 'textarea' : variant.includes('contenteditable') ? 'div' : 'input');
      if (variant.includes('contenteditable')) field.contentEditable = 'true';
      document.body.append(field); field.focus();
      const event = new KeyboardEvent('keydown', {
        key: variant.startsWith('printable') || variant === 'AltGraph' ? 'ĸ' : 'k', code: 'KeyK', ctrlKey: true, altKey: true,
        modifierAltGraph: variant === 'AltGraph', isComposing: variant === 'composing', keyCode: variant === '229' ? 229 : 0,
        bubbles: true, cancelable: true,
      });
      field.dispatchEvent(event);
      return { prevented: event.defaultPrevented, focused: document.activeElement === field };
    }, variant);
    assert.deepEqual(result, { prevented: false, focused: true });
    assert.equal(await page.locator('[data-quick-switcher]').count(), 0);
  } finally { await browser.close(); }
});

for (const fallback of [false, true]) test(`composing Enter preserves switcher before normal Enter, keyCode fallback ${fallback}`, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(async () => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.generated.js');
      openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Calendar', href: '/calendar' }], read: async () => ({ board: { deals: [] }, network: { nodes: [] } }) });
    });
    const input = page.getByRole('combobox');
    await input.waitFor();
    const result = await input.evaluate((field, fallback) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: !fallback, keyCode: fallback ? 229 : 13, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      return { prevented: event.defaultPrevented, open: !!document.querySelector('[data-quick-switcher]'), pathname: location.pathname };
    }, fallback);
    assert.deepEqual(result, { prevented: false, open: true, pathname: '/' });
    await input.press('Enter');
    await page.waitForURL('**/calendar');
  } finally { await browser.close(); }
});

for (const variant of ['composing', '229', 'AltGraph', 'printable']) test(`global walkthrough preserves ${variant} text entry`, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    const result = await page.evaluate(async variant => {
      const { openWalkthrough } = await import('/js/app-walkthrough.js');
      openWalkthrough(document);
      const field = document.createElement('input'); document.body.append(field); field.focus();
      const event = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, altKey: variant === 'AltGraph' || variant === 'printable', modifierAltGraph: variant === 'AltGraph', isComposing: variant === 'composing', keyCode: variant === '229' ? 229 : 0, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      return { open: !!document.querySelector('[data-walkthrough]'), prevented: event.defaultPrevented };
    }, variant);
    assert.deepEqual(result, { open: true, prevented: false });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-walkthrough]').count(), 0);
  } finally { await browser.close(); }
});

for (const fallback of [false, true]) test(`global slash search preserves composition, keyCode fallback ${fallback}`, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}/deals?view=national`);
    await page.locator('#accountGrid [data-account]').first().waitFor();
    assert.equal(await page.evaluate(fallback => {
      const event = new KeyboardEvent('keydown', { key: '/', isComposing: !fallback, keyCode: fallback ? 229 : 0, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }, fallback), false);
    await page.keyboard.press('/');
    assert.equal(await page.locator('#search').evaluate(el => el === document.activeElement), true);
  } finally { await browser.close(); }
});

for (const query of ['needle', 'absent']) test(`held read completes with ${query} query and clears to pages`, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(async () => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.generated.js');
      openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Calendar', href: '/calendar' }], read: () => new Promise(resolve => { window.finishSwitcherRead = resolve; }) });
    });
    const input = page.getByRole('combobox');
    await input.fill(query);
    await page.getByText('Loading accessible items…').waitFor();
    await page.evaluate(() => window.finishSwitcherRead({ board: { deals: [{ id: 'needle', name: 'Needle deal' }] }, network: { nodes: [] } }));
    if (query === 'needle') await page.getByRole('option', { name: 'Needle deal Deal' }).waitFor();
    else await page.getByText('No matches. Try a deal, contact or page name.').waitFor();
    await input.fill('');
    await page.getByRole('option', { name: 'Calendar Page' }).waitFor();
    await input.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Quick switcher' }).evaluate(el => el === document.activeElement), true);
  } finally { await browser.close(); }
});

for (const phase of ['loading', 'error', 'open_empty', 'typing', 'no_results']) for (const close of ['Escape', 'outside']) test(`${phase} closes with ${close} and restores focus`, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(server.url);
    const opener = page.getByRole('button', { name: 'Quick switcher' });
    await opener.waitFor();
    await page.evaluate(async phase => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.generated.js');
      openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Calendar', href: '/calendar' }], read: () => phase === 'loading' ? new Promise(() => {}) : phase === 'error' ? Promise.reject(Error('Unavailable')) : Promise.resolve({ board: { deals: [] }, network: { nodes: [] } }) });
    }, phase);
    const input = page.getByRole('combobox');
    await input.waitFor();
    if (phase === 'loading') await page.getByText('Loading accessible items…').waitFor();
    else if (phase === 'error') await page.getByText('Deals and contacts unavailable. Pages are still available.').waitFor();
    else {
      await page.getByText('1 destinations', { exact: true }).waitFor();
      if (phase === 'typing') await input.fill('calendar');
      if (phase === 'no_results') { await input.fill('absent'); await page.getByText('No matches. Try a deal, contact or page name.').waitFor(); }
    }
    if (close === 'Escape') await input.press('Escape'); else await page.mouse.click(5, 5);
    await input.waitFor({ state: 'detached' });
    assert.equal(await opener.evaluate(el => el === document.activeElement), true);
  } finally { await browser.close(); }
});

for (const phase of ['loading', 'error']) test(`${phase} page result navigates with Enter`, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(async phase => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.generated.js');
      openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Calendar', href: '/calendar' }], read: () => phase === 'loading' ? new Promise(() => {}) : Promise.reject(Error('Unavailable')) });
    }, phase);
    await page.getByText(phase === 'loading' ? 'Loading accessible items…' : 'Deals and contacts unavailable. Pages are still available.').waitFor();
    await page.getByRole('combobox').press('Enter');
    await page.waitForURL('**/calendar');
  } finally { await browser.close(); }
});

test('arrow selection wraps exactly and Tab excludes background controls', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(async () => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.generated.js');
      openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Calendar', href: '/calendar' }, { label: 'Deals', href: '/deals' }], read: async () => ({ board: { deals: [] }, network: { nodes: [] } }) });
    });
    const input = page.getByRole('combobox');
    await input.waitFor();
    for (const [key, id] of [['ArrowUp', 'quick-option-1'], ['ArrowDown', 'quick-option-0'], ['ArrowDown', 'quick-option-1'], ['ArrowDown', 'quick-option-0']]) {
      await input.press(key);
      assert.equal(await input.getAttribute('aria-activedescendant'), id);
    }
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      assert.equal(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement.closest('[data-quick-switcher]')), true);
    }
  } finally { await browser.close(); }
});
