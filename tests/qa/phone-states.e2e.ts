import { expect } from 'e2e';
import { test, baseUrl, seedFixture, type FixtureVariant, QA_NAMESPACE } from './support.ts';

const variants = ['large', 'empty'] satisfies FixtureVariant[];

for (const variant of variants) {
  test(`phone ${variant} collections remain usable across deals, leads, and invoices`, {session:'joe'}, async ({app,browser}) => {
    const seeded=await seedFixture(baseUrl(app),`${QA_NAMESPACE}-phone-${variant}`,'joe',variant,true);
    await browser.setCookies([seeded.cookie]);
    await browser.setViewport({width:390,height:844});

    await app.open('/deals?mode=live');
    await expect(browser.locator('.kanban-card')).toHaveCount(seeded.counts.deals);
    if (variant==='large') {
      const lastDeal=browser.locator('.kanban-card[data-id="qa-deal-160"]');
      await lastDeal.scrollIntoView();
      await lastDeal.tap();
      await expect(browser.locator('#panelTitle')).toContainText('160');
      await app.screenshot('phone-large-deal-detail');
      await browser.locator('#panelClose').tap();
    } else {
      await app.screenshot('phone-empty-deals');
    }

    await app.open('/leads?mode=live');
    if (variant==='large') {
      const lastLead=browser.locator('.lead-card').last();
      await lastLead.scrollIntoView();
      await lastLead.tap();
      await expect(browser.locator('#leadDetail')).toBeVisible();
      await expect(browser.locator('#detailTitle')).toContainText('Dr. Demo');
      await app.screenshot('phone-large-lead-detail');
      await browser.locator('#closeDetail').tap();
    } else {
      await expect(browser.locator('.lead-card')).toHaveCount(0);
      await expect(browser.locator('#hotLeads')).toContainText('No New leads');
      await app.screenshot('phone-empty-leads');
    }

    await app.open('/invoices?mode=live');
    await expect(browser.locator('.invoice-row')).toHaveCount(seeded.counts.invoices);
    if (variant==='large') {
      const lastInvoice=browser.locator('.invoice-row').last();
      await lastInvoice.scrollIntoView();
      await lastInvoice.tap();
      await expect(browser.locator('#invoiceDetail')).toBeVisible();
      await expect(browser.locator('#invoiceDetailTitle')).toContainText('Demo Invoice Practice');
      await app.screenshot('phone-large-invoice-detail');
      await browser.locator('#closeInvoiceDetail').tap();
    } else {
      await expect(browser.locator('#invoiceRows')).toContainText('No invoices match');
      await app.screenshot('phone-empty-invoices');
    }
  });
}
