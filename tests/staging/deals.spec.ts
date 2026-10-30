import { test, expect } from '@playwright/test';
import { withJourneyFixture } from './journey-fixture.mjs';
import { parkedDeals } from './journey-flows.mjs';

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
  await parkedDeals(page);
});

test('Deal detail expands update history and preserves it through refresh', async ({ page }) => {
  test.setTimeout(420000);
  await withJourneyFixture(async fixture => {
    await page.goto(`/deals?deal=${fixture.deal.id}`);
    await expect(page.locator('#detailUpdateForm')).toBeVisible();
    const history = page.locator('.updates-history');
    await expect(history).toHaveCount(1);
    await history.locator(':scope > summary').click();
    await expect(history.locator('.deal-note')).toHaveCount(2);
    await expect(history.locator('.deal-note p')).toHaveText(fixture.deal.updates.toReversed());
    await expect(history.locator('.deal-note').first()).toBeVisible();
    const observed = await page.locator('#detailUpdated').getAttribute('datetime');
    await page.getByRole('button', { name: 'Refresh deal', exact: true }).click();
    await expect(page.locator('#detailUpdated')).not.toHaveAttribute('datetime', observed || '', { timeout: 27000 });
    await expect(history).toHaveAttribute('open', '');
  });
});

test('Deal card omits Dates, Full record and outlook controls', async ({ page }) => {
  test.setTimeout(420000);
  await withJourneyFixture(async fixture => {
    await page.goto(`/deals?deal=${fixture.deal.id}`);
    await expect(page.locator('#detailUpdateForm')).toBeVisible();
    await expect(page.locator('.deal-dates,.full-record,[data-jev-deal],#dealDateDialog')).toHaveCount(0);
  });
});

test('An unsaved Update draft clears when the deal reopens', async ({ page }) => {
  test.setTimeout(420000);
  await withJourneyFixture(async fixture => {
    await page.goto(`/deals?deal=${fixture.deal.id}`);
    const update = page.getByLabel('Update', { exact: true });
    await expect(update).toHaveValue('');
    await update.fill('Synthetic unsaved review draft');
    await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
    await page.goto(`/deals?deal=${fixture.deal.id}`);
    await expect(update).toHaveValue('');
  });
});
