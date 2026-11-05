import { test, expect } from '@playwright/test';

test.describe.configure({ retries: 0 });

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Local Deals switches board and list views and inspects a deal', async ({ page }) => {
  await page.goto('/deals');
  await expect(page.locator('.card-open').first()).toBeVisible();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.locator('#listView')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.locator('#boardView')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.card-open').first().click();
  await expect(page.locator('#recordPanel')).toBeVisible();
  await expect(page.locator('#panelTitle')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
  await expect(page.locator('#recordPanel')).toBeHidden();
});

test('Local Deals shows parked records and recent changes read-only', async ({ page }) => {

  await page.goto('/deals');
  await expect(page.locator('.card-open').first()).toBeVisible();
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  await expect(page.locator('#parkedToggle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  await expect(page.locator('#parkedToggle')).toHaveAttribute('aria-pressed', 'false');
  const today = page.getByRole('button', { name: 'Today sidebar', exact: true });
  if (await today.getAttribute('aria-expanded') === 'true') await today.click();
  await expect(page.locator('#appToday')).toBeHidden();
  await today.click();
  await expect(page.locator('#appToday')).toBeVisible();
});

test('Deal detail expands update history and preserves it through refresh', async ({ page }) => {
  await page.goto('/deals');
  const card = page.locator('.card-open').filter({ hasText: 'Synthetic staging QA' }).first();
  await expect(card).toBeVisible();
  await card.click();
  const dealURL = page.url();
  await page.goto(dealURL);
  await expect(page.locator('#detailUpdateForm')).toBeVisible();
  const history = page.locator('.updates-history');
  await expect(history).toHaveCount(1);
  await history.locator(':scope > summary').click();
  await expect(history.locator('.deal-note')).toHaveCount(2);
  await expect(history.locator('.deal-note p')).toHaveText([
    'Synthetic staging QA follow-up update', 'Synthetic staging QA initial update',
  ]);
  await expect(history.locator('.deal-note').first()).toBeVisible();
  const observed = await page.locator('#detailUpdated').getAttribute('datetime');
  await page.getByRole('button', { name: 'Refresh deal', exact: true }).click();
  await expect(page.locator('#detailUpdated')).not.toHaveAttribute('datetime', observed || '', { timeout: 27000 });
  await expect(history).toHaveAttribute('open', '');
});

test('Deal card omits Dates, Full record and outlook controls', async ({ page }) => {
  await page.goto('/deals');
  const card = page.locator('.card-open').filter({ hasText: 'Synthetic staging QA' }).first();
  await expect(card).toBeVisible();
  await card.click();
  const dealURL = page.url();
  await page.goto(dealURL);
  await expect(page.locator('#detailUpdateForm')).toBeVisible();
  await expect(page.locator('.deal-dates,.full-record,[data-jev-deal],#dealDateDialog')).toHaveCount(0);
});

test('An unsaved Update draft clears when the deal reopens', async ({ page }) => {
  await page.goto('/deals');
  const card = page.locator('.card-open').filter({ hasText: 'Synthetic staging QA' }).first();
  await expect(card).toBeVisible();
  await card.click();
  const dealURL = page.url();
  await page.goto(dealURL);
  const update = page.getByLabel('Update', { exact: true });
  await expect(update).toHaveValue('');
  await update.fill('Synthetic unsaved review draft');
  await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
  await page.goto(dealURL);
  await expect(update).toHaveValue('');
});
