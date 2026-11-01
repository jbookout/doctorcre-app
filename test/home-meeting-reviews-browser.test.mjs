import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

let server, browser;
before(async () => { server = await fixtureServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.close(); });

for (const theme of ['dark', 'light']) for (const action of ['dismiss', 'log']) test(`meeting ${action} labels at 390px in ${theme}`, async t => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
  await page.goto(server.origin);
  await page.evaluate(async () => {
    const { mountHomeMeetingReviews } = await import('/js/home-meeting-reviews.js');
    const pending = () => new Promise((resolve, reject) => { window.rejectMeeting = reject; });
    mountHomeMeetingReviews({ document, host: document.getElementById('homeMeetingReviews'), client: { logActivity: pending, answerBoardQuestion: pending } }).update({ actor: 'joe', deals: [{ id: 'd14', name: 'Demo clinic', owner: 'joe' }], calendar: { follow_up_reviews: [{ key: 'aaaaaaaaaaaaaaaa', state: 'needs_review', title: 'Demo lender meeting', start: '2026-10-01T13:00:00Z', end: '2026-10-01T14:00:00Z' }] } });
  });
  const card = page.locator('#homeMeetingReviews article');
  await card.locator('select').selectOption('d14');
  await card.locator(`[data-review-${action}]`).click();
  assert.equal(await card.locator('[data-review-log]').textContent(), action === 'log' ? 'Logging…' : 'It happened');
  assert.equal(await card.locator('[data-review-dismiss]').textContent(), action === 'dismiss' ? 'Saving…' : 'Dismiss');
  await page.waitForFunction(() => typeof window.rejectMeeting === 'function');
  await page.evaluate(() => window.rejectMeeting(new TypeError('Synthetic response loss')));
  await card.locator('.work-card-status').waitFor();
  assert.equal(await card.locator('[data-review-log]').textContent(), action === 'log' ? 'Check meeting log' : 'It happened');
  assert.equal(await card.locator('[data-review-dismiss]').textContent(), action === 'dismiss' ? 'Check dismissal' : 'Dismiss');
  assert.equal(await card.locator(`[data-review-${action}]`).isEnabled(), true);
  assert.equal(await card.locator(`[data-review-${action === 'log' ? 'dismiss' : 'log'}]`).isDisabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (action === 'dismiss') {
    await card.scrollIntoViewIfNeeded();
    await mkdir('out/test-artifacts/home-meeting-reviews', { recursive: true });
    await page.screenshot({ path: `out/test-artifacts/home-meeting-reviews/uncertain-dismissal-390-${theme}.png`, animations: 'disabled' });
  }
});
