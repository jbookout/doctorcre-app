import { expect } from 'e2e';
import { reproTest, refuseReads } from './support.mjs';

const test = reproTest();
for (const status of [503,401,403]) test(`QA-008 Tours pending freshness settles after ${status} retry`, { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await refuseReads(browser,status);
  await app.open('/tours?mode=live');
  await expect(browser.locator('#tour-library-state')).toContainText(status === 503 ? /unavailable/i : /sign in/i);
  await screen.getByRole('button', 'Refresh tours', { exact: true }).focus();
  await screen.getByRole('button', 'Refresh tours', { exact: true }).press('Enter');
  await expect(browser.locator('#tour-library-state')).toContainText(status === 503 ? /unavailable/i : /sign in/i);
  await expect(browser.locator('#planner-updated')).toContainText('Unavailable');
  await expect(browser.locator('.app-layout-status')).not.toContainText('Updating…');
});
