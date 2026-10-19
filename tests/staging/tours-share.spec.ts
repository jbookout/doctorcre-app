import { test, expect } from '@playwright/test';
import { requireStagingAuthority, withJourneyFixture } from './journey-fixture.mjs';
import { shareLifecycle } from './journey-flows.mjs';

test('Share without a confidential link reveals no properties or feedback controls', async ({ page }) => {
  await page.goto('/share');
  await expect(page.locator('#status')).not.toBeEmpty({ timeout: 27000 });
  await expect(page.locator('#report-list li')).toHaveCount(0);
  await expect(page.locator('#open-tour')).toBeDisabled();
});

test('A confidential Share issues, exchanges and revokes without exposing unrelated properties', async ({ page }) => {
  test.setTimeout(420000);
  await requireStagingAuthority(page.request);
  await withJourneyFixture(fixture => shareLifecycle(page, fixture));
});
