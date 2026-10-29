import { expect } from 'e2e';
import { reproTest, refuseReads } from './support.mjs';

const test = reproTest();
test('QA-019 reviewing Tours retains unavailable-client recovery', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await refuseReads(app, browser);
  await app.open('/tours?mode=live');
  await expect(browser.locator('#plan-message')).toContainText(/unavailable/i);
  await expect(browser.locator('#plan-client option')).toHaveCount(1);
  await screen.getByRole('textbox', 'Tour name').fill('Demo review packet');
  await screen.getByRole('textbox', 'Tour notes').fill('Synthetic fixture tour notes');
  await screen.getByRole('button', 'Review packet draft', { exact: true }).tap();
  await expect(browser.locator('#plan-message')).toContainText(/unavailable/i);
  await expect(browser.locator('#plan-message')).toContainText(/refresh|retry|try again/i);
});

test('QA-019 client access denial retires packet review and offers sign-in', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await refuseReads(app, browser, 401);
  await app.open('/tours?mode=live');
  await expect(screen.getByRole('heading', 'Session ended')).toBeVisible();
  await expect(browser).toHaveURL('/public-shell/session-ended.html');
  await expect(browser.locator('#plan-message, #plan-client, #plan-form')).toHaveCount(0);
  await expect(screen.getByRole('link', /^Sign in again$/i)).toHaveAttribute('href', /auth\/login/);
});
