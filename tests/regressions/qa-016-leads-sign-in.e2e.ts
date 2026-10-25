import { expect } from 'e2e';
import { reproTest, refuseReads } from './support.mjs';

const test = reproTest();
test('QA-016 sign-in refusal offers accessible recovery', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await refuseReads(browser, 401);
  await app.open('/leads?mode=live');
  await expect(screen.getByRole('heading', 'Session ended')).toBeVisible();
  await expect(browser).toHaveURL('/public-shell/session-ended.html');
  await expect(browser.locator('#leadBoard')).toHaveCount(0);
  await expect(screen.getByRole('link', /^Sign in again$/i)).toBeVisible();
  await expect(screen.getByRole('link', /^Sign in again$/i)).toHaveAttribute('href', /auth\/login/);
});
