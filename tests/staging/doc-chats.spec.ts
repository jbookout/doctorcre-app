import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Doc Chats reads conversations, toggles archived and parked suggestions', async ({ page }) => {
  await page.goto('/doc-chats');
  await expect(page.locator('#visibleCountLine')).not.toHaveText('unknown', { timeout: 27000 });
  await expect(page.locator('#listStateTitle')).not.toContainText('unavailable');
  await page.locator('#archivedToggle').click();
  await expect(page.locator('#archivedToggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#archivedToggle').click();
  await expect(page.locator('#archivedToggle')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#suggestionsParked').click();
  await expect(page.locator('#suggestionsParked')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#suggestionsParked').click();
});

test('Doc Chats opens a conversation and reads turns and access', async ({ page }) => {
  await page.goto('/doc-chats');
  await expect(page.locator('#visibleCountLine')).not.toHaveText('unknown', { timeout: 27000 });
  const conversation = page.locator('#conversationList [data-open]').first();
  test.skip(await conversation.count() === 0, 'Staging has no test conversation to inspect.');
  await conversation.click();
  await expect(page.locator('#conversationId')).not.toBeEmpty();
  await expect(page.locator('#turnsState')).not.toHaveAttribute('data-state', 'loading', { timeout: 27000 });
  await expect(page.locator('#sharingCaveat')).not.toHaveText('unknown');
});
