import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Tour planner filters its library and refreshes', async ({ page }) => {
  await page.goto('/tours');
  await expect(page.locator('#planner-updated')).not.toHaveText('Updating…', { timeout: 27000 });
  await expect(page.locator('#tour-library-state')).toBeEmpty();
  await expect(page.locator('#tour-library-state')).not.toContainText('unavailable');
  await page.locator('#tour-filter').fill('V2 no tour 35f9009c');
  await expect(page.locator('.tour-button')).toHaveCount(0);
  await expect(page.locator('#upcoming-tours')).toContainText('No matching tours');
  await page.locator('#tour-filter').fill('');
  await page.getByRole('button', { name: 'Refresh tours', exact: true }).click();
  await expect(page.locator('#planner-updated')).toContainText('Updated');
});

test('Tour planner keeps and undoes a private draft and territory search', async ({ page }) => {
  await page.goto('/tours');
  await expect(page.locator('#planner-updated')).not.toHaveText('Updating…', { timeout: 27000 });
  await expect(page.locator('#tour-library-state')).toBeEmpty();
  await page.locator('#plan-name').fill('V2 private draft');
  await page.locator('#plan-undo').click();
  await expect(page.locator('#plan-name')).toHaveValue('');
  await page.getByRole('button', { name: 'Pensacola', exact: true }).click();
  await expect(page.locator('#space-area')).toHaveValue('Pensacola, FL');
  await page.locator('#space-use').fill('Medical office');
  await page.getByRole('button', { name: 'Save search draft', exact: true }).click();
  await expect(page.locator('#space-message')).toHaveText('Search draft saved.');
  await page.reload();
  await expect(page.locator('#space-use')).toHaveValue('Medical office');
});

test('Tour library opens details and its itinerary link', async ({ page }) => {
  await page.goto('/tours');
  await expect(page.locator('#planner-updated')).not.toHaveText('Updating…', { timeout: 27000 });
  await expect(page.locator('#tour-library-state')).toBeEmpty();
  test.skip(await page.locator('.tour-button').count() === 0, 'Staging has no tour; detail requires a test tour.');
  await page.locator('.tour-button').first().click();
  await expect(page.locator('#tour-dialog')).toBeVisible();
  await expect(page.locator('#detail-message')).toBeEmpty({ timeout: 27000 });
  await expect(page.getByRole('link', { name: 'Edit itinerary', exact: true })).toHaveAttribute('href', /route-editor\.html\?tour=/);
  await page.getByRole('button', { name: 'Close tour details', exact: true }).click();
  await expect(page.locator('#tour-dialog')).toBeHidden();
});

test('V2-C01: Planner completes its first signed-in read', async ({ page }) => {
  await page.goto('/tours');
  await expect(page.locator('#planner-updated')).toContainText('Updated', { timeout: 27000 });
});

test('Tour planner refreshes then reviews a private packet and removes its attachment', async ({ page }) => {
  await page.goto('/tours');
  await expect(page.locator('#planner-updated')).not.toHaveText('Updating…', { timeout: 27000 });
  await page.getByRole('button', { name: 'Refresh tours', exact: true }).click();
  await expect(page.locator('#plan-client option')).not.toHaveCount(1, { timeout: 27000 });
  await page.locator('#plan-client').selectOption({ index: 1 });
  await page.locator('#plan-name').fill('V2 private packet review');
  await page.locator('#packet-upload').setInputFiles({ name: 'v2-synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic staging packet attachment; no client information.') });
  await expect(page.locator('#packet-files li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Review packet draft', exact: true }).click();
  await expect(page.locator('#tour-dialog')).toBeVisible();
  await expect(page.locator('#detail-content')).toContainText('Private draft');
  await expect(page.locator('#detail-content')).toContainText('v2-synthetic.txt');
  await page.getByRole('button', { name: 'Close tour details', exact: true }).click();
  await page.getByRole('button', { name: 'Remove v2-synthetic.txt', exact: true }).click();
  await expect(page.locator('#file-count')).toHaveText('0 files');
});

test.fixme('V2-F01: A single private packet attachment is labelled 1 files', { tag: '@fixme' }, async ({ page }) => {
  await page.goto('/tours');
  await page.locator('#packet-upload').setInputFiles({ name: 'v2-synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic staging attachment.') });
  await expect(page.locator('#file-count')).toHaveText('1 file');
});
