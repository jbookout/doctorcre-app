import { expect } from 'e2e';
import { reproTest, paintedText } from './support.mjs';

const test = reproTest();
test('QA-001 account menu labels remain fully painted beside the rail', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/');
  await screen.getByRole('button', /account and settings/i).tap();
  await browser.keyboard.press('Tab');
  await expect(screen.getByRole('link', 'Notification preferences')).toBeVisible();
  const label = await paintedText(browser, '#accountMenu a[href*="prefForm"]');
  expect(label.full, JSON.stringify(label)).toBe(true);
});
