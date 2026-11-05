import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

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
    await page.locator('#quickAddDraft').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('doctorcre:quick-add-drafts:v1:joe')).length), 1);
    await mkdir('/tmp/WR617.S18.J1-evidence', { recursive: true });
    await page.screenshot({ path: `/tmp/WR617.S18.J1-evidence/${width}-${theme}.png`, fullPage: true });
    await page.locator('#quickAddDate').fill('2028-02-29');
    assert.doesNotMatch(await page.locator('#quickAddQuestion').textContent(), /review.*2026-02-31/i);
    await page.locator('#quickAddForm').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.getElementById('quickAddInput').value === '');
    assert.equal(await page.locator('#quickAddDate').inputValue(), '');
  });
}
