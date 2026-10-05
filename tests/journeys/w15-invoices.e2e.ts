import { productTest } from './test.mjs';
const test = productTest();
import { expect } from 'e2e';

// The fixture ages invoices from today, so a payment date must be today too.
const today = new Date().toLocaleDateString('en-CA');

// W15: the invoice tracker filters by age and status and records a payment;
// Home surfaces the overdue invoices for the chosen scope.
test('W15 invoice tracker filters by age and status and records a payment', async ({ app, browser, quality }) => {
  await app.open('/invoices');
  const rows = browser.locator('[data-invoice]');

  await expect(rows).toHaveCount(6);
  await quality.check('invoices');
  await browser.locator('#invoiceAging [data-age="2"]').tap();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Demo Bay Relocation');
  await browser.locator('#allAges').tap();
  await expect(rows).toHaveCount(4);

  await quality.controls();
  await browser.locator('#clearInvoiceFilters').tap();
  await quality.controls(false);
  await browser.locator('[data-status="awaiting"]').tap();
  await expect(rows).toHaveCount(1);
  await rows.tap();
  await expect(browser.locator('#invoiceDetailFacts')).toContainText('Awaiting invoice');
  await expect(browser.locator('#invoicePayment')).toBeHidden();
  await browser.locator('#closeInvoiceDetail').tap();

  await browser.locator('[data-status="unpaid"]').tap();
  await rows.filter({ hasText: 'Demo Harbor Renewal' }).tap();
  await expect(browser.locator('#invoiceDetail')).toBeVisible();
  await quality.check('invoice-payment');
  await browser.locator('#invoicePaidDate').fill(today);
  await browser.locator('#markInvoicePaid').tap();
  await expect(browser.locator('#invoiceDetailFacts')).toContainText('Paid');
  await expect(browser.locator('#invoicePayment')).toBeHidden();
});

test('W15 Home invoice attention lists overdue invoices for the chosen scope', async ({ app, browser, quality }) => {
  await app.open('/');

  const attention = browser.locator('#homeInvoices [data-home-key]');
  await expect(attention).toHaveCount(3);
  await quality.check('home-invoices');
  await expect(attention).toContainText(['Demo Cedar Expansion', 'Demo Bay Relocation', 'Demo Oak Purchase']);
  await browser.locator('[data-scope="mine"]').tap();
  await expect(attention).toHaveCount(2);
  await browser.locator('[data-scope="team"]').tap();
  await expect(attention).toHaveCount(3);
});
