import { expect } from '@playwright/test';
import { test } from './privacy';
import { deal, designated, needs, tab } from './ui';

test("46 WR591.S35", async ({ page }) => {
  const dealId = await deal(page);
  await tab(page, /^Tours$/);
  const tour = page.locator('[data-open-tour]').filter({ hasText: designated }).first();
  needs(!await tour.count(), 'existing TEST tour with long planner fields');
  await tour.click();
  const frame = page.frameLocator('iframe[title="Tour shortlist, route and packet"]');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const fields = frame.locator('input:visible:not([type="checkbox"]), textarea:visible');
    await expect.poll(() => fields.count()).toBeGreaterThan(0);
    for (let n = 0; n < Math.min(await fields.count(), 30); n++) {
      const field = fields.nth(n);
      const value = await field.inputValue();
      await field.focus();
      expect(await field.evaluate(node => {
        const control = node as HTMLInputElement;
        const bounds = control.getBoundingClientRect();
        return document.activeElement === control && bounds.left >= 0 && bounds.right <= innerWidth && control.scrollWidth <= control.clientWidth + 1;
      })).toBe(true);
      expect(await field.inputValue() === value).toBe(true);
    }
    expect(new URL(page.url()).searchParams.get('deal') === dealId).toBe(true);
  }
});
