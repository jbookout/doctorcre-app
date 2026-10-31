import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { businessDay } from '../../js/business-date.js';

const today = businessDay();

test('W15 invoice tracker filters by age and status and records a payment', async ({ app, browser }) => {
  await app.open('/invoices');
  const rows = browser.locator('[data-invoice]');

  await expect(rows).toHaveCount(6);
  await browser.locator('#invoiceAging [data-age="2"]').tap();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Demo Bay Relocation');
  await browser.locator('#allAges').tap();
  await expect(rows).toHaveCount(4);

  if (await browser.locator('#appSidebar').isHidden()) await browser.locator('#appSidebarToggle').tap();
  await browser.locator('#clearInvoiceFilters').tap();
  if (await browser.evaluate(() => innerWidth <= 760) && await browser.locator('#appSidebar').isVisible()) await browser.locator('[data-layout-close="sidebar"]').tap();
  await browser.locator('[data-status="awaiting"]').tap();
  await expect(rows).toHaveCount(1);
  await rows.tap();
  await expect(browser.locator('#invoiceDetailFacts')).toContainText('Awaiting invoice');
  await expect(browser.locator('#invoicePayment')).toBeHidden();
  await browser.locator('#closeInvoiceDetail').tap();

  await browser.locator('[data-status="unpaid"]').tap();
  await rows.filter({ hasText: 'Demo Harbor Renewal' }).tap();
  await expect(browser.locator('#invoiceDetail')).toBeVisible();
  await browser.locator('#invoicePaidDate').fill(today);
  await browser.locator('#markInvoicePaid').tap();
  await expect(browser.locator('#invoiceDetailFacts')).toContainText('Paid');
  await expect(browser.locator('#invoicePayment')).toBeHidden();
});
