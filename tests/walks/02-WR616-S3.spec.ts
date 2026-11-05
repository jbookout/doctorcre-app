import { test, expect } from '@playwright/test';
import './privacy';
import { card, designated, needs, noOverflow, visible } from './ui';

test("02 WR616.S3", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const row = await card(page);
    await visible(page.getByRole('heading', { name: 'Needs your attention', exact: false }));
    await visible(page.getByRole('heading', { name: 'Your brief', exact: true }));
    await visible(page.locator('.home-week'));
    await row.locator('h3 a').click();
    const selected = new URL(page.url()).pathname;
    const source = row.getByRole('link', { name: /Open source record/ });
    needs(!await source.count(), 'Home card linked to a designated test deal');
    const href = await source.getAttribute('href');
    needs(!href?.startsWith('/deals'), 'Home card linked to a designated test deal');
    await source.click();
    await visible(page.locator('#recordPanel'));
    await page.goBack();
    expect(new URL(page.url()).pathname === selected).toBe(true);
    await page.reload();
    expect(new URL(page.url()).pathname === selected).toBe(true);
    await noOverflow(page);
  }
});
