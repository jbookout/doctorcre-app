import { test, expect } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { directoryFixture } from '../../test/fixtures/vendor-directory.synthetic.mjs';

test.use({ baseURL: async ({}, use) => {
  const server = await startFixtureServer();
  try { await use(server.url); } finally { await server.stop(); }
} });

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`Vendor layout at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('**/api/v1/business/**', route => route.fulfill({ json: directoryFixture(route.request().url()) }));
    await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), dismiss => dismiss.click());
    await page.goto('/vendors');
    await expect(page.locator('.record-row').first()).toBeVisible();
    await expect(page.locator('#appTodayNeeds [data-layout-deal]').first()).toBeAttached();
    await page.screenshot({ path: testInfo.outputPath(`directory-${width}-${theme}.png`) });
    if (width === 1440) {
      const task = page.locator('#appTodayNeeds [data-layout-deal]').first();
      const name = await task.locator('strong').textContent();
      await expect.soft(page.locator('#appWorkingList [data-layout-deal]:visible strong, #appTodayNeeds [data-layout-deal]:visible strong').filter({ hasText: name })).toHaveCount(1);
      const rows = await page.locator('.record-row').first().boundingBox();
      expect.soft(rows.width).toBeGreaterThan(950);
    } else {
      const completeRows = await page.locator('.record-row').evaluateAll(rows => {
        const bottom = document.querySelector('.app-layout-status').getBoundingClientRect().top;
        return rows.filter(row => { const rect = row.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= bottom; }).length;
      });
      expect.soft(completeRows).toBeGreaterThanOrEqual(3);
      await expect.soft(page.locator('#pageFooter')).toHaveText('DoctorCRE · Vendors');
    }
    await page.locator('.record-row').first().click();
    await expect(page.getByRole('dialog', { name: 'Demo Partner 01' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`detail-${width}-${theme}.png`) });
  });
}
