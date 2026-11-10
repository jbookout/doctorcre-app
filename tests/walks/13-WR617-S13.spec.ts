import { expect } from '@playwright/test';
import { test } from './privacy';
import { card, complete, marker, needs, reloadCard, undo, visible } from './ui';

test("13 WR617.S13", async ({ page }) => {
  const row = await card(page, 13);
  const id = await row.getAttribute('data-inbox-row');
  const unrelated = page.locator('[data-inbox-row]').filter({ has: page.locator('h3 a').filter({ hasText: marker(13) }) }).nth(1);
  needs(!await unrelated.count(), 'second TEST WALK 13 card to verify unchanged state');
  const before = await unrelated.innerText();
  await row.getByRole('button', { name: 'Review card', exact: true }).click();
  await complete(page, row);
  await visible(page.locator('.inbox-notice').getByRole('button', { name: /^Undo/ }));
  expect(await unrelated.innerText() === before).toBe(true);
  const check = await page.context().newPage();
  try {
    const stored = await reloadCard(check, id!);
    expect(await stored.getByRole('button', { name: 'Mark done', exact: true }).count()).toBe(0);
  } finally { await check.close(); }
  await row.getByRole('button', { name: 'Close review', exact: true }).click();
  await undo(page);
});
