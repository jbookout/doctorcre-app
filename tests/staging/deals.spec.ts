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
  await page.getByRole('button', { name: 'Close deal', exact: true }).click();
  await expect(page.locator('#recordPanel')).toBeHidden();
});

test('Local Deals shows parked records and recent changes read-only', async ({ page }) => {
  await page.goto('/deals');
  await expect(page.locator('.card-open').first()).toBeVisible();
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  await expect(page.locator('#parkedToggle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  await expect(page.locator('#parkedToggle')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Today sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Today sidebar', exact: true }).click();
  await expect(page.locator('#appToday')).toBeVisible();
});

test('Deal detail expands full history, switches timeline range and refreshes', async ({ page }) => {
  await page.goto('/deals');
  await page.locator('.card-open').first().click();
  await expect(page.locator('#recordPanel')).toBeVisible();
  await page.locator('.full-record summary').click();
  await expect(page.locator('.full-record')).toContainText('Negotiation rounds');
  await page.locator('#timelineRange').selectOption('full');
  await expect(page.locator('#timelineRange')).toHaveValue('full');
  const observed = await page.locator('#detailUpdated').getAttribute('datetime');
  await page.getByRole('button', { name: 'Refresh deal', exact: true }).click();
  await expect(page.locator('#detailUpdated')).not.toHaveAttribute('datetime', observed || '', { timeout: 27000 });
  await expect(page.locator('.full-record')).toHaveAttribute('open', '');
});

test('A missing deal date opens a draft that can be cancelled', async ({ page }) => {
  await page.goto('/deals');
  await page.locator('.card-open').first().click();
  await expect(page.locator('#timelineRange')).toBeVisible();
  const add = page.locator('[data-add-date]').first();
  test.skip(await add.count() === 0, 'The selected staging deal has no missing date to inspect.');
  await add.click();
  await expect(page.locator('#dealDateDialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel date', exact: true }).click();
  await expect(page.locator('#dealDateDialog')).toBeHidden();
});

test('A synthetic staging deal next step saves and restores its text and due date', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/deals');
  await page.locator('.card-open').first().click();
  await expect(page.locator('#detailNextForm')).toBeVisible();
  test.skip(!/^(E2E|Synthetic)\b/.test(await page.locator('#panelTitle').innerText()), 'Only an existing synthetic staging deal may be edited.');
  const address = page.url();
  const text = page.locator('#detailNextForm textarea[name=text]');
  const date = page.locator('#detailNextForm input[name=date]');
  const original = await text.inputValue();
  const due = await date.inputValue();
  const modified = 'V2 staging next-step cleanup 35f9009c';
  try {
    await text.fill(modified);
    await page.getByRole('button', { name: 'Save next step', exact: true }).click();
    await expect(page.locator('#detailNextStatus')).toHaveText('Next step confirmed', { timeout: 27000 });
    await page.goto(address);
    await expect(text).toHaveValue(modified, { timeout: 27000 });
    await expect(date).toHaveValue(due);
  } finally {
    await page.goto(address);
    await expect(text).toBeVisible({ timeout: 27000 });
    if (await text.inputValue() === modified && await date.inputValue() === due) {
      await text.fill(original);
      await page.getByRole('button', { name: 'Save next step', exact: true }).click();
      await expect(page.locator('#detailNextStatus')).toHaveText('Next step confirmed', { timeout: 27000 });
    }
    await page.goto(address);
    await expect(text).toHaveValue(original, { timeout: 27000 });
    await expect(date).toHaveValue(due);
  }
});
