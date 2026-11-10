import { expect } from '@playwright/test';
import { test } from './privacy';
import { card, marker, needs, visible } from './ui';

test("10 WR617.S12", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await card(page, 10);
    const rows = page.locator('[data-inbox-row]').filter({ has: page.locator('h3 a').filter({ hasText: marker(10) }) });
    needs(await rows.count() < 2, 'two TEST WALK 10 Home cards');
    const ids = await rows.evaluateAll(nodes => nodes.slice(0, 2).map(node => node.getAttribute('data-inbox-row')));
    for (const action of ['Settle selected', 'Snooze selected']) {
      for (const id of ids) await page.locator(`[data-inbox-row=${JSON.stringify(id)}] input[type="checkbox"]`).check();
      await page.getByRole('button', { name: action, exact: true }).click();
      if (action === 'Snooze selected') await page.getByRole('button', { name: /^Not now/ }).click();
      const results = page.getByRole('region', { name: 'Batch results', exact: true });
      const undoButton = results.getByRole('button', { name: 'Undo whole batch', exact: true });
      await visible(undoButton);
      await page.waitForTimeout(10_000);
      expect(await undoButton.isVisible()).toBe(true);
      await undoButton.click();
      await expect.poll(() => results.getAttribute('data-batch-state')).toBe('undone');
      for (const id of ids) expect(await page.locator(`[data-inbox-row=${JSON.stringify(id)}]`).count()).toBe(1);
      await results.getByRole('button', { name: 'Finish reviewing batch', exact: true }).click();
      expect(await page.evaluate(() => document.activeElement?.matches('[data-inbox-row] h3 a, .home-slice h2'))).toBe(true);
    }
  }
});
