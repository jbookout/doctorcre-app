import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';

async function accountPage(t, { width = 1280, seed } = {}) {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  await page.clock.install({ time: new Date('2026-10-19T15:00:00Z') });
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  if (seed) await page.route('**/data/board-seed.json', route => route.fulfill({ json: seed }));
  await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
  await page.locator('.account-card').first().waitFor();
  await page.waitForLoadState('networkidle');
  return page;
}

test('Add national account labels resolve uniquely to their editable fields', async t => {
  const page = await accountPage(t);
  await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
  await page.locator('#stickyAddButton').click();
  await page.locator('#formDialog').waitFor({ state: 'visible' });
  const duplicates = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  assert.deepEqual(duplicates, [], 'form and account context IDs must be unique');
  await page.getByLabel('Brand / organization', { exact: true }).fill('Demo New Account');
  await page.getByLabel('Account owner', { exact: true }).selectOption('joe');
  assert.equal(await page.locator('#dialogBody input[name="name"]').inputValue(), 'Demo New Account');
});

for (const recovery of [false, true]) for (const interval of [1400, 15000]) {
  test(`${recovery ? 'Clear search' : 'Next action'} keeps keyboard focus after ${interval}ms refresh`, async t => {
    const page = await accountPage(t);
    await page.locator('.account-card').first().click();
    if (recovery) {
      await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
      await page.locator('#search').fill('zz-no-synthetic-match');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Escape');
    }
    const control = page.locator(recovery ? '[data-clear-search]' : '#stats [data-open-deal]');
    await control.focus();
    const identity = await control.getAttribute(recovery ? 'data-clear-search' : 'data-open-deal');
    await page.clock.fastForward(interval);
    assert.equal(await control.evaluate(node => document.activeElement === node), true, 'refresh retains the same logical control');
    assert.equal(await control.getAttribute(recovery ? 'data-clear-search' : 'data-open-deal'), identity);
  });
}

test('Territory search hides the selected account context until the search is cleared', async t => {
  const page = await accountPage(t);
  await page.locator('.account-card').first().click();
  assert.equal(await page.locator('#accountContext').isVisible(), true);
  await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
  await page.locator('#search').fill('Demo');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('#rows tr').count() > 0);
  assert.equal(await page.locator('#accountContext').isVisible(), false, 'territory results must not be labeled as one account');
});

for (const next_date of ['2026-10-18', '2026-10-20']) {
  test(`Next account action breaks exact name and date ties by record ID for ${next_date}`, async t => {
    const seed = { deals: ['demo-z', 'demo-a'].map(id => ({
      id, name: 'Demo Same Name', next_date, next_step: `Review ${id}`, phase: 'Legal',
      attention: true, last_touch: '2026-10-18',
    })) };
    const page = await accountPage(t, { seed });
    await page.locator('.account-card').first().click();
    assert.equal(await page.locator('#stats [data-open-deal]').getAttribute('data-open-deal'), 'demo-a');
    await page.clock.fastForward(15000);
    assert.equal(await page.locator('#stats [data-open-deal]').getAttribute('data-open-deal'), 'demo-a');
  });
}

for (const query of ['Demo', 'zz-no-synthetic-match']) {
  test(`Returning to accounts clears search and restores the selected phone card for ${query}`, async t => {
    const page = await accountPage(t, { width: 390 });
    const card = page.locator('.account-card').first();
    const accountId = await card.getAttribute('data-account');
    await card.click();
    await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
    await page.locator('#search').fill(query);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await page.locator('#accountBack').click();
    assert.equal(await page.locator('#accountGrid').isVisible(), true, 'return shows the account grid even with a search');
    assert.equal(await page.locator('#search').inputValue(), '');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.account), accountId);
    await page.clock.fastForward(15000);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.account), accountId);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#accountContext').isVisible(), true);
  });
}

for (const width of [360, 390]) {
  test(`Open account stays on one line inside the ${width}px phone card`, async t => {
    const page = await accountPage(t, { width });
    const lines = await page.locator('.account-card .account-summary').first().evaluate(summary => {
      const walker = document.createTreeWalker(summary, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        const start = text.textContent.indexOf('Open account');
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + 'Open account'.length);
        return [...range.getClientRects()].map(rect => ({ top: rect.top, right: rect.right }));
      }
      return [];
    });
    assert.equal(lines.length, 1, `Open account must not wrap between words: ${JSON.stringify(lines)}`);
    assert.ok(lines[0].right <= width, 'the caption fits inside the phone viewport');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
}
