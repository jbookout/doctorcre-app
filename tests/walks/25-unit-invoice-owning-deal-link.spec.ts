import { test, expect } from '@playwright/test';
import './privacy';
import { designated, needs, visible } from './ui';

test("25 unit:invoice-owning-deal-link", async ({ page }) => {
  const pending = page.waitForResponse(response => response.url().endsWith('/mcp') && response.request().postDataJSON()?.params?.name === 'read-invoice-tracker');
  await page.goto('/invoices');
  const envelope = await (await pending).json();
  const payload = JSON.parse(envelope.result.content.find((entry: { type: string }) => entry.type === 'text').text);
  const records = payload.entries.filter((entry: { name: string }) => designated.test(entry.name))
    .map((entry: { commission_id: string | null; deal_id: string }) => ({ key: entry.commission_id || `awaiting:${entry.deal_id}`, deal: entry.deal_id }));
  needs(!records.length, 'invoice belonging to a designated TEST deal');
  const record = records[0];
  await page.locator(`[data-invoice=${JSON.stringify(record.key)}]`).click();
  const dialog = page.getByRole('dialog', { name: designated });
  await visible(dialog);
  const link = dialog.getByRole('link', { name: 'Open deal', exact: true });
  expect(new URL((await link.getAttribute('href'))!, 'https://app.doctorcre.com').searchParams.get('deal') === record.deal).toBe(true);
  await link.click();
  await visible(page.locator('#recordPanel'));
  expect(new URL(page.url()).searchParams.get('deal') === record.deal).toBe(true);
  await page.goBack();
  await visible(page.locator(`[data-invoice=${JSON.stringify(record.key)}]`));
});
