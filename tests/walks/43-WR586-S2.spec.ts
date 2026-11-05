import { test, expect } from '@playwright/test';
import './privacy';
import { deal, needs, tab, visible } from './ui';

test("43 WR586.S2", async ({ page }) => {
  const dealId = await deal(page);
  await tab(page, /^Tours$/);
  await visible(page.getByRole('heading', { name: 'Properties & tours', exact: true }));
  const tours = page.locator('[data-open-tour]');
  needs(!await tours.count(), 'test deal with an existing tour');
  const tourId = await tours.first().getAttribute('data-open-tour');
  await tours.first().click();
  const frame = page.locator('iframe[title="Tour shortlist, route and packet"]');
  await visible(frame);
  const src = new URL((await frame.getAttribute('src'))!, 'https://app.doctorcre.com');
  expect(src.searchParams.get('deal') === dealId && src.searchParams.get('tour') === tourId).toBe(true);
  await page.goto('/tours');
  const link = page.locator(`a[href*="${encodeURIComponent(dealId)}"]`).first();
  needs(!await link.count(), 'cross-deal Tours library owning-deal link for test tour');
  await link.click();
  expect(new URL(page.url()).searchParams.get('deal') === dealId).toBe(true);
});
