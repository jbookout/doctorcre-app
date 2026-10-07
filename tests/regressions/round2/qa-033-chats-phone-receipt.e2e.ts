import { expect } from 'e2e';
import { reproTest } from '../support.mjs';

const test = reproTest();
test('QA-033 phone Chats command receipt keeps its safety key above the footer', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open('/doc-chats?mode=live');
  await screen.getByRole('button', 'Dismiss morning brief', { exact: true }).tap();
  await expect(browser.locator('.suggestion-card')).toHaveCount(2);
  await browser.locator('.suggestion-card [data-work-number]').nth(0).fill('205');
  await browser.locator('.suggestion-card button[data-choice="act"]').nth(0).tap();
  await expect(browser.locator('#receiptDock .receipt[data-state="confirmed"]')).toHaveCount(1);
  await app.screenshot('qa-033-command-safety-key-under-footer');
  const geometry = await browser.evaluate(() => {
    const key = document.querySelector('#receiptDock .receipt[data-state="confirmed"] small');
    const footer = document.querySelector('.app-layout-status');
    if (!key || !footer) return { found: false, keyReadable: false };
    const range = document.createRange(); range.selectNodeContents(key);
    const rects = [...range.getClientRects()].map(r => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }));
    const footerTop = footer.getBoundingClientRect().top;
    return { found: true, text: key.textContent, footerTop, rects, keyReadable: rects.length > 0 && rects.every(r => r.bottom <= footerTop) };
  });
  expect(geometry.found).toBe(true);
  expect(geometry.keyReadable, JSON.stringify(geometry)).toBe(true);
});
