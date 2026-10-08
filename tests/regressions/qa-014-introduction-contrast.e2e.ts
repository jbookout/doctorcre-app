import { expect } from 'e2e';
import { reproTest, textContrast } from './support.mjs';

const test = reproTest();
test('QA-014 dark suggested introduction description has readable contrast', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/');
  await screen.getByRole('button', 'Just Me', { exact: true }).tap();
  const reason = browser.locator('#homeIntroductions .relationship-card strong').first();
  await expect(reason).toBeVisible();
  await reason.scrollIntoView();
  const color = await textContrast(browser, '#homeIntroductions .relationship-card strong');
  expect(color.ratio, JSON.stringify(color)).toBeGreaterThanOrEqual(4.5);
});
