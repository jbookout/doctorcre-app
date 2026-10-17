import { test, expect } from '@playwright/test';

test.describe.configure({ retries: 0 });

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Ideas search and clear a loaded board, including its empty state', async ({ page }) => {
  await page.goto('/ideas-events?tab=ideas');
  await expect(page.locator('#ideaStatusLabel')).toHaveText('Current', { timeout: 27000 });
  await page.locator('#ideaSearch').fill('V2 no idea 35f9009c');
  await expect(page.locator('.idea-tile')).toHaveCount(0);
  await page.locator('#ideaSearch').fill('');
  await expect(page.locator('#ideaStatusLabel')).toHaveText('Current');
});

test('A parked idea opens and closes without answering it', async ({ page }) => {
  await page.goto('/ideas-events?tab=ideas');
  await expect(page.locator('#ideaStatusLabel')).toHaveText('Current', { timeout: 27000 });
  test.skip(await page.locator('.idea-tile').count() === 0, 'Staging has no parked idea; detail requires a test record.');
  await page.locator('.idea-tile').first().click();
  await expect(page.locator('#ideaDialog')).toBeVisible();
  await page.locator('#ideaDialogClose').click();
  await expect(page.locator('#ideaDialog')).toBeHidden();
});

test.fixme('V2-F02: Ideas navigation intermittently times out before the app shell loads', { tag: '@fixme' }, async ({ page }) => {
  await page.goto('/ideas-events?tab=ideas');
  await expect(page.getByRole('button', { name: 'Joe: account and settings', exact: true })).toBeVisible();
});

test('Events tab opens and cancels a draft without saving', async ({ page }) => {
  await page.goto('/ideas-events?tab=ideas');
  await page.getByRole('tab', { name: 'Events', exact: true }).click();
  await expect(page).toHaveURL(/tab=events/);
  await page.getByRole('button', { name: 'Add event', exact: true }).click();
  await expect(page.locator('#eventDialog')).toBeVisible();
  await page.getByRole('textbox', { name: 'Event name', exact: true }).fill('V2 discarded draft');
  await page.getByRole('button', { name: 'Close event form', exact: true }).click();
  await expect(page.locator('#eventDialog')).toBeHidden();
  await expect(page.locator('#eventList')).not.toContainText('V2 discarded draft');
});

test('V2-B01: Events load and a synthetic event edit is saved and restored', async ({ page }) => {
  await page.goto('/ideas-events?tab=events');
  await expect(page.locator('#eventState')).not.toHaveAttribute('data-state', 'loading', { timeout: 27000 });
  await expect(page.locator('#eventState')).not.toHaveAttribute('data-state', 'unavailable');
  const first = page.locator('.event-card').first();
  await first.click();
  const id = await first.getAttribute('data-event-id');
  const original = await page.locator('#eventTitle').inputValue();
  test.skip(!/^(Synthetic|E2E)\b/i.test(original), 'Only synthetic staging events may be changed.');
  const modified = original + ' [V2 staging cleanup]';
  try {
    await page.locator('#eventTitle').fill(modified);
    await page.locator('#eventSave').click();
    await expect(page.locator('#eventDialog')).toBeHidden();
    await expect(page.locator('.event-card[data-event-id="' + id + '"]')).toContainText(modified);
  } finally {
    await page.goto('/ideas-events?tab=events');
    const card = page.locator('.event-card[data-event-id="' + id + '"]');
    await card.click();
    if (await page.locator('#eventTitle').inputValue() === modified) {
      await page.locator('#eventTitle').fill(original);
      await page.locator('#eventSave').click();
      await expect(page.locator('#eventDialog')).toBeHidden();
    }
    await expect(card).toContainText(original);
  }
});
