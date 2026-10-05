import { expect } from 'e2e';
import { reproTest, refuseReads } from './support.mjs';

const test = reproTest();
test('QA-019 reviewing Tours retains unavailable-client recovery', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await refuseReads(browser);
  await app.open('/tours?mode=live');
  await expect(browser.locator('#plan-message')).toContainText(/unavailable/i);
  await expect(browser.locator('#plan-client option')).toHaveCount(1);
  await screen.getByRole('textbox', 'Tour name').fill('Demo review packet');
  await screen.getByRole('textbox', 'Tour notes').fill('Synthetic fixture tour notes');
  await screen.getByRole('button', 'Review packet draft', { exact: true }).tap();
  await expect(browser.locator('#plan-message')).toContainText(/unavailable/i);
  await expect(browser.locator('#plan-message')).toContainText(/refresh|retry|try again/i);
});
