import { expect } from 'e2e';
import { reproTest, paintedText } from './support.mjs';

const test = reproTest();
test('QA-001 account menu labels remain fully painted beside the rail', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/');
  await screen.getByRole('button', /account and settings/i).focus();
  await browser.keyboard.press('Enter');
  await browser.keyboard.press('Tab');
  expect(await browser.evaluate(() => document.activeElement?.id)).toBe('accountProfile');
  await expect(screen.getByRole('link', 'Notification preferences')).toBeVisible();
  const label = await paintedText(browser, '#accountMenu a[href*="prefForm"]');
  expect(label.full, JSON.stringify(label)).toBe(true);
  await browser.keyboard.press('Shift+Tab');
  expect(await browser.evaluate(() => document.activeElement?.id)).toBe('selfAvatar');
  await browser.keyboard.press('Enter');
  await browser.keyboard.press('Tab');
  await browser.keyboard.press('Escape');
  await expect(browser.locator('#accountMenu')).not.toBeVisible();
  expect(await browser.evaluate(() => document.activeElement?.id)).toBe('selfAvatar');
});
