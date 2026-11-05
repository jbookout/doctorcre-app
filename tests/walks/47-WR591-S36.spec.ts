import { test, expect } from '@playwright/test';
import './privacy';
import { noOverflow, visible } from './ui';

test("47 WR591.S36", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/deals');
    for (const id of ['boardView', 'listView', 'closedView', 'lostView', 'parkedToggle']) {
      const button = page.locator(`#${id}`);
      await visible(button);
      await button.click();
      expect(await button.getAttribute('aria-pressed') === 'true').toBe(true);
      const box = await button.boundingBox();
      expect(Boolean(box && box.x >= 0 && box.x + box.width <= width)).toBe(true);
      await noOverflow(page);
      await button.focus();
      await page.keyboard.press('Enter');
    }
    await page.locator('#listView').click();
    await page.goto('/');
    await page.goBack();
    expect(await page.locator('#listView').getAttribute('aria-pressed') === 'true').toBe(true);
  }
});
