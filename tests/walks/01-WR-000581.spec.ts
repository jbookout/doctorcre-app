import { test, expect } from '@playwright/test';
import './privacy';
import { card, complete, marker, needs, reloadCard, undo } from './ui';

test("01 WR-000581", async ({ page }) => {
  const row = await card(page, 1);
  const context = await row.locator('.inbox-context').innerText();
  const siblings = page.locator('[data-inbox-row]').filter({ has: page.locator('h3 a').filter({ hasText: marker(1) }) });
  needs(await siblings.count() < 2, 'two TEST WALK 1 actions on the same test deal');
  const sibling = siblings.nth(1);
  expect(await sibling.locator('.inbox-context').innerText() === context).toBe(true);
  expect(await sibling.getByRole('button', { name: 'Mark done', exact: true }).isVisible()).toBe(true);
  const id = await complete(page, row);
  const check = await page.context().newPage();
  try {
    const stored = await reloadCard(check, id);
    expect(await stored.getByRole('button', { name: 'Mark done', exact: true }).count()).toBe(0);
    const siblingId = await sibling.getAttribute('data-inbox-row');
    const storedSibling = await reloadCard(check, siblingId!);
    expect(await storedSibling.getByRole('button', { name: 'Mark done', exact: true }).isVisible()).toBe(true);
  } finally { await check.close(); }
  await undo(page);
  await reloadCard(page, id);
  expect(await page.locator('[data-current] button').filter({ hasText: /^Mark done$/ }).isVisible()).toBe(true);
});
