import { expect } from '@playwright/test';
import { test } from './privacy';
import { card, complete, reloadCard, undo } from './ui';

test("12 unit:inbox-reopen-action", async ({ page }) => {
  const row = await card(page, 12);
  const id = await complete(page, row);
  await undo(page);
  const stored = await reloadCard(page, id);
  expect(await stored.getByRole('button', { name: 'Mark done', exact: true }).isVisible()).toBe(true);
});
