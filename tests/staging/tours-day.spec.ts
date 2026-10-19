import { test, expect } from '@playwright/test';
import { requireStagingAuthority, withJourneyFixture } from './journey-fixture.mjs';
import { tourDay } from './journey-flows.mjs';

test('Tour day reports a missing tour and disables recording', async ({ page }) => {
  await page.goto('/tours/day.html');
  await expect(page.locator('#day-status')).toHaveText('Tour unavailable', { timeout: 27000 });
  await expect(page.locator('#day-record')).toBeDisabled();
});

test('An accepted tour opens day mode, selects a stop and returns from property detail', async ({ page }) => {
  test.setTimeout(420000);
  await requireStagingAuthority(page.request);
  await withJourneyFixture(fixture => tourDay(page, fixture));
});
