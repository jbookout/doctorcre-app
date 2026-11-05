import { test, expect } from '@playwright/test';
import './privacy';
import { card, complete, needs, reloadCard, undo, visible } from './ui';

test("03 WR617.S1", async ({ page }) => {
  const row = await card(page, 3);
  const id = await row.getAttribute('data-inbox-row');
  await row.getByRole('button', { name: 'Hide from inbox', exact: true }).click();
  await visible(page.locator('.inbox-notice').getByRole('button', { name: /^Undo/ }));
  const check = await page.context().newPage();
  try {
    const stored = await reloadCard(check, id!);
    expect(await stored.getByRole('button', { name: 'Show in inbox', exact: true }).count()).toBe(1);
  } finally { await check.close(); }
  await undo(page);
  await row.getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.getByRole('dialog', { name: 'Snooze cards', exact: true }).getByRole('button', { name: /^1 hour/ }).click();
  await visible(row.getByRole('button', { name: 'Wake', exact: true }));
  await undo(page);
  await complete(page, row);
  await undo(page);
  for (const name of ['In motion and waiting', 'Done today', 'Hidden from inbox']) {
    expect(await page.getByRole('region', { name, exact: true }).count()).toBe(1);
  }
  needs(true, 'already auto-settled TEST WALK 3 card plus stored Working disposition evidence');
});
