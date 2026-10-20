import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
  test(`Account opens with the oldest overdue action at ${width}px ${theme}`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await page.clock.setFixedTime(new Date('2026-10-19T15:00:00Z'));
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
    await page.locator('.account-card').first().click();
    const summary = page.locator('#stats');
    assert.match(await summary.innerText(), /Next overdue action/);
    const nextAction = summary.getByRole('button');
    assert.match(await nextAction.innerText(), /Review sample documents/);
    assert.match(await nextAction.innerText(), /Demo Vision Center/);
    assert.match(await summary.innerText(), /4 overdue dates/);
    assert.equal(await page.locator('#focusStrip').innerText(), '');
    assert.ok(await nextAction.evaluate(node => node.getBoundingClientRect().bottom < innerHeight), 'next action fits the first phone viewport');
    await nextAction.click();
    await page.waitForURL('**/deals?deal=*');
    await page.locator('#detailUpdateForm').waitFor();
    assert.match(await page.locator('#recordPanel').innerText(), /Demo Vision Center/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
}

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
  test(`Empty account search keeps the query and recovery in the workspace at ${width}px ${theme}`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
    await page.locator('.account-card').first().click();
    await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
    await page.locator('#search').fill('zz-no-synthetic-match');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    assert.match(await page.locator('#emptyState').innerText(), /zz-no-synthetic-match/);
    assert.equal(await page.locator('#stats').isVisible(), false, 'empty results have no zero-value dashboard');
    const clear = page.locator('#emptyState').getByRole('button', { name: 'Clear search', exact: true });
    assert.equal(await clear.isVisible(), true);
    await clear.click();
    await page.locator('#rows tr').first().waitFor();
    assert.equal(await page.locator('#search').inputValue(), '');
    assert.equal(await page.locator('#emptyState').isVisible(), false);
    assert.equal(await page.locator('#stats').isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'accountContextName', 'recovery restores focus to the account heading');
  });
}

test('Clearing an empty portfolio search returns focus to the account card', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
  await page.locator('.account-card').first().waitFor();
  await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
  await page.locator('#search').fill('zz-no-synthetic-match');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await page.locator('#emptyState').getByRole('button', { name: 'Clear search', exact: true }).click();
  await page.locator('.account-card').first().waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.dataset.account), 'demo-account-001');
});
