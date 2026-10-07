import { expect } from 'e2e';
import { reproTest, refuseReads } from './support.mjs';

const test = reproTest();
test('QA-016 sign-in refusal offers accessible recovery', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await refuseReads(browser, 401);
  await app.open('/leads?mode=live');
  await expect(browser.locator('#leadBoardError')).toContainText(/sign.in required/i);
  await expect(screen.getByRole('link', /^Sign in$/i)).toBeVisible();
  await expect(screen.getByRole('link', /^Sign in$/i)).toHaveAttribute('href', /auth\/login/);
});
