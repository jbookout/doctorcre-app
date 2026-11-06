import { expect } from '@playwright/test';
import { test } from './privacy';
import { card, marker, needs, undo, visible } from './ui';

test("33 unit:inbox-card-actions", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const row = await card(page, 33);
    const unrelated = page.locator('[data-inbox-row]').filter({ has: page.locator('h3 a').filter({ hasText: marker(33) }) }).nth(1);
    needs(!await unrelated.count(), 'second TEST WALK 33 card');
    const before = await unrelated.innerText();
    await row.getByRole('button', { name: 'Hide from inbox', exact: true }).click();
    await visible(row.getByRole('button', { name: 'Show in inbox', exact: true }));
    expect(await unrelated.innerText() === before).toBe(true);
    await undo(page);
    expect(await row.getByRole('button', { name: 'Hide from inbox', exact: true }).isVisible()).toBe(true);
  }
});
