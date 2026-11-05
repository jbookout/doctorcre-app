import { expect } from 'e2e';
import { reproTest, refuseReads } from './support.mjs';

const test = reproTest();
test('QA-019 reviewing Tours retains unavailable-client recovery', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await refuseReads(app, browser);
  await app.open('/tours?mode=live');
  await expect(browser.locator('#tour-library-state')).toContainText(/unavailable/i);
  await expect(browser.locator('#plan-form, #create-tour-form')).toHaveCount(0);
});

test('QA-019 client access denial retires packet review and offers sign-in', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await refuseReads(app, browser, 401);
  await app.open('/tours?mode=live');
  await expect(screen.getByRole('heading', 'Session ended')).toBeVisible();
  await expect(browser).toHaveURL('/public-shell/session-ended.html');
  await expect(browser.locator('#plan-message, #plan-client, #plan-form')).toHaveCount(0);
  await expect(screen.getByRole('link', /^Sign in again$/i)).toHaveAttribute('href', /auth\/login/);
});
