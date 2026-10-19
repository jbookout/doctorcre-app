import { test, expect } from '@playwright/test';
import { createLoopFixture } from './loop-fixture';

test('Choose work reads Team/Mine and opens a record without changing it', async ({ page }) => {
  const fixture = await createLoopFixture(page.request, 'team_loop');
  try {
    await page.goto('/doc-chats/work');
    await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
    await expect(page.locator('#taskStatusLabel')).toHaveText('Current', { timeout: 27000 });
    await page.getByRole('button', { name: 'Mine', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mine', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Team', exact: true }).click();
    const record = page.locator('#taskList [data-task]').filter({ hasText: fixture.title });
    await expect(record).toBeVisible();
    await record.click();
    await expect(page.locator('#taskDialog')).toBeVisible();
    await expect(page.locator('#taskDialogRows')).not.toBeEmpty();
    await page.locator('#taskDialogClose').click();
    await expect(page.locator('#taskDialog')).toBeHidden();
  } finally {
    await fixture.cleanup();
  }
});
