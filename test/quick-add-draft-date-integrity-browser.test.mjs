import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { openTasks, waitForTasks } from './task-page-fixture.mjs';

for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
  test(`stored impossible date requires review at ${width} ${theme}`, async t => {
    const server = await fixtureServer();
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage({ viewport: { width, height: 960 } });
    await page.addInitScript(theme => {
      localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } }));
      localStorage.setItem('doctorcre:quick-add-drafts:v1:joe', JSON.stringify([{ id: 'bad-date', sentence: 'Call lender', dueDate: '2026-02-31', savedAt: 17 }]));
    }, theme);
    await page.goto(`${server.origin}/doc-chats/work`);
    await page.locator('[data-restore-draft="bad-date"]').click();
    assert.equal(await page.locator('#quickAddInput').inputValue(), 'Call lender');
    assert.equal(await page.locator('#quickAddDate').inputValue(), '');
    await page.locator('#quickAddForm').evaluate(form => form.requestSubmit());
    assert.match(await page.locator('#quickAddQuestion').textContent(), /2026-02-31.*review|review.*2026-02-31/i);
    assert.equal(await page.locator('#quickAddInput').inputValue(), 'Call lender');
    await page.locator('#quickAddInput').fill('Call lender after review');
    await page.locator('#quickAddDate').dispatchEvent('change');
    await page.locator('#quickAddForm').evaluate(form => form.requestSubmit());
    assert.equal(await page.locator('#quickAddInput').inputValue(), 'Call lender after review');
    await page.locator('#quickAddInput').fill('Call lender');
    await page.locator('#quickAddDraft').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('doctorcre:quick-add-drafts:v1:joe')).length), 1);
    await mkdir('/tmp/WR617.S18.J1-evidence', { recursive: true });
    await page.screenshot({ path: `/tmp/WR617.S18.J1-evidence/${width}-${theme}.png`, fullPage: true });
    await page.locator('#quickAddDate').fill('2028-02-29');
    assert.doesNotMatch(await page.locator('#quickAddQuestion').textContent(), /review.*2026-02-31/i);
    await page.locator('#quickAddForm').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.getElementById('quickAddInput').value === '');
    assert.equal(await page.locator('#quickAddDate').inputValue(), '');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('doctorcre:quick-add-drafts:v1:joe')).length), 0);
  });
}

test('account replacement drops the prior date review and sentence', async t => {
  const { page } = await openTasks(t, `
    localStorage.setItem('doctorcre:quick-add-drafts:v1:joe', JSON.stringify([{ id: 'bad-date', sentence: 'Call lender', dueDate: '2026-02-31', savedAt: 17 }]));
    const getBoard = c.getBoard;
    c.getBoard = async args => ({ ...await getBoard(args), actor: window.dateActor || 'joe' });
  `);
  await waitForTasks(page);
  await page.locator('[data-restore-draft="bad-date"]').click();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitForTasks(page);
  await page.locator('#quickAddForm').evaluate(form => form.requestSubmit());
  assert.match(await page.locator('#quickAddQuestion').textContent(), /Review the saved date/);
  await page.evaluate(() => { window.dateActor = 'dell'; window.dispatchEvent(new Event('online')); });
  await page.waitForFunction(() => document.getElementById('quickAddInput').value === '');
  await waitForTasks(page);
  assert.equal(await page.locator('[data-restore-draft="bad-date"]').count(), 0);
  assert.doesNotMatch(await page.locator('#quickAddQuestion').textContent(), /Review the saved date/);
});

test('selecting a valid saved draft restores its text and date without a review obligation', async t => {
  const { page } = await openTasks(t, `
    localStorage.setItem('doctorcre:quick-add-drafts:v1:joe', JSON.stringify([
      { id: 'bad-date', sentence: 'Call lender', dueDate: '2026-02-31', savedAt: 17 },
      { id: 'valid-date', sentence: '  Read valid draft  ', dueDate: '2028-02-29', savedAt: 18 }
    ]));
  `);
  await waitForTasks(page);
  await page.locator('[data-restore-draft="bad-date"]').click();
  assert.match(await page.locator('#quickAddQuestion').textContent(), /Review the saved date/);
  await page.locator('[data-restore-draft="valid-date"]').click();
  assert.equal(await page.locator('#quickAddInput').inputValue(), '  Read valid draft  ');
  assert.equal(await page.locator('#quickAddDate').inputValue(), '2028-02-29');
  assert.doesNotMatch(await page.locator('#quickAddQuestion').textContent(), /Review the saved date/);
});

test('account replacement clears a corrected draft before filing without writing', async t => {
  const { page } = await openTasks(t, `
    localStorage.setItem('doctorcre:quick-add-drafts:v1:joe', JSON.stringify([{ id: 'bad-date', sentence: 'Call lender', dueDate: '2026-02-31', savedAt: 17 }]));
    const getBoard = c.getBoard;
    c.getBoard = async args => ({ ...await getBoard(args), actor: window.dateActor || 'joe' });
    window.quickAddWrites = [];
    const addLoop = c.addLoop;
    c.addLoop = async args => { window.quickAddWrites.push(args); return addLoop(args); };
  `);
  await waitForTasks(page);
  await page.locator('[data-restore-draft="bad-date"]').click();
  await page.locator('#quickAddDate').fill('2028-02-29');
  assert.doesNotMatch(await page.locator('#quickAddQuestion').textContent(), /Review the saved date/);
  await page.evaluate(() => { window.dateActor = 'dell'; window.dispatchEvent(new Event('online')); });
  await waitForTasks(page);
  assert.equal(await page.locator('#quickAddInput').inputValue(), '');
  assert.equal(await page.locator('#quickAddDate').inputValue(), '');
  assert.equal(await page.locator('[data-restore-draft="bad-date"]').count(), 0);
  assert.doesNotMatch(await page.locator('#quickAddQuestion').textContent(), /Review the saved date/);
  assert.equal(await page.evaluate(() => window.quickAddWrites.length), 0);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('doctorcre:quick-add-drafts:v1:joe'))[0].dueDate), '2026-02-31');
});

test('a verified replacement account loads and selects its own saved draft', async t => {
  const { page } = await openTasks(t, `
    localStorage.setItem('doctorcre:quick-add-drafts:v1:joe', JSON.stringify([{ id: 'joe-date', sentence: 'Read Joe draft', dueDate: '2026-03-01', savedAt: 17 }]));
    localStorage.setItem('doctorcre:quick-add-drafts:v1:dell', JSON.stringify([{ id: 'dell-date', sentence: '  Read Dell draft  ', dueDate: '2028-02-29', savedAt: 18 }]));
    const getBoard = c.getBoard;
    c.getBoard = async args => ({ ...await getBoard(args), actor: window.dateActor || 'joe' });
  `);
  await waitForTasks(page);
  assert.equal(await page.locator('[data-restore-draft="joe-date"]').count(), 1);
  assert.equal(await page.locator('[data-restore-draft="dell-date"]').count(), 0);
  await page.evaluate(() => { window.dateActor = 'dell'; window.dispatchEvent(new Event('online')); });
  await waitForTasks(page);
  assert.equal(await page.locator('[data-restore-draft="joe-date"]').count(), 0);
  await page.locator('[data-restore-draft="dell-date"]').click();
  assert.equal(await page.locator('#quickAddInput').inputValue(), '  Read Dell draft  ');
  assert.equal(await page.locator('#quickAddDate').inputValue(), '2028-02-29');
  assert.doesNotMatch(await page.locator('#quickAddQuestion').textContent(), /Review the saved date/);
});
