import { test, expect } from '@playwright/test';

test('Choose work reads Team/Mine and opens a record without changing it', async ({ page }) => {
  await page.goto('/doc-chats/work');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#taskStatusLabel')).toHaveText('Current', { timeout: 27000 });
  await page.getByRole('button', { name: 'Mine', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mine', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  const record = page.locator('#taskList [data-task]').first();
  test.skip(await record.count() === 0, 'Staging has no open partner record to inspect.');
  await record.click();
  await expect(page.locator('#taskDialog')).toBeVisible();
  await expect(page.locator('#taskDialogRows')).not.toBeEmpty();
  await page.locator('#taskDialogClose').click();
  await expect(page.locator('#taskDialog')).toBeHidden();
});
