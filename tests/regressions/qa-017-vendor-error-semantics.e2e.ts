import { expect } from 'e2e';
import { reproTest, refuseReads } from './support.mjs';

const test = reproTest();
test('QA-017 Vendors unavailable feedback exposes alert or status semantics', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await refuseReads(browser);
  await app.open('/vendors?mode=live');
  await expect(screen.getByText('This did not load', { exact: true })).toBeVisible();
  const liveFailure = browser.locator('[role="alert"], [role="status"]').filter({ hasText: /This did not load|Temporarily unavailable/i });
  await expect(liveFailure).toHaveCount(1);
});
