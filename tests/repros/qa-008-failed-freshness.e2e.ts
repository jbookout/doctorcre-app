import { expect } from 'e2e';
import { reproTest, refuseReads } from './support.mjs';

const test = reproTest();
test('QA-008 Tours pending freshness settles after failed retry', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await refuseReads(browser);
  await app.open('/tours?mode=live');
  await expect(browser.locator('#tour-library-state')).toContainText(/unavailable/i);
  await screen.getByRole('button', 'Refresh tours', { exact: true }).focus();
  await screen.getByRole('button', 'Refresh tours', { exact: true }).press('Enter');
  await expect(browser.locator('#tour-library-state')).toContainText(/unavailable/i);
  await expect(browser.locator('.app-layout-status')).not.toContainText('Updating…');
});
