import { reproTest } from './support.mjs';
import { expect } from 'e2e';

const test = reproTest();
test('QA-009 returning from a non-first conversation prompts thread selection', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/doc-chats');
  const row = browser.locator('#conversationList button[data-open]').nth(1);
  await expect(row).toBeVisible();
  await row.tap();
  await expect(browser.locator('#turnsState')).toBeHidden();
  await browser.back();
  await expect(browser).toHaveURL('/doc-chats');
  await expect(browser.locator('#turnsStateTitle')).toHaveText(/select|choose|open/i);
});
