import { reproTest } from './support.mjs';
import { expect } from 'e2e';

const test = reproTest();
for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) test(`QA-009 returning from a non-first conversation prompts thread selection at ${viewport.width}px`, { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await browser.setViewport(viewport);
  await app.open('/doc-chats');
  const controls = ['renameInput', 'renameSave', 'pinToggle', 'archiveToggle'];
  for (const id of controls) await expect(browser.locator(`#${id}`)).toBeDisabled();
  const row = browser.locator('#conversationList button[data-open]').nth(1);
  await expect(row).toBeVisible();
  await row.tap();
  await expect(browser.locator('#turnsState')).toBeHidden();
  for (const id of controls) await expect(browser.locator(`#${id}`)).toBeEnabled();
  await browser.back();
  await expect(browser).toHaveURL('/doc-chats');
  await expect(browser.locator('#turnsStateTitle')).toHaveText(/select|choose|open/i);
  for (const id of controls) await expect(browser.locator(`#${id}`)).toBeDisabled();
  await browser.locator('#conversationList button[data-open]').first().tap();
  for (const id of controls) await expect(browser.locator(`#${id}`)).toBeEnabled();
});
