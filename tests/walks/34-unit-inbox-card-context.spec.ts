import { expect } from '@playwright/test';
import { test } from './privacy';
import { card, needs, reloadCard, visible } from './ui';

test("34 unit:inbox-card-context", async ({ page }) => {
  const row = await card(page);
  const id = await row.getAttribute('data-inbox-row');
  await row.locator('h3 a').click();
  const source = row.getByRole('link', { name: /Open source record/ });
  needs(!await source.count(), 'test inbox card with linked deal context');
  const href = await source.getAttribute('href');
  needs(!href?.startsWith('/deals'), 'test inbox card linked to a deal');
  const dealId = new URL(href!, 'https://app.doctorcre.com').searchParams.get('deal');
  expect(Boolean(dealId)).toBe(true);
  await source.click();
  await visible(page.locator('#recordPanel'));
  expect(new URL(page.url()).searchParams.get('deal') === dealId).toBe(true);
  const restored = await reloadCard(page, id!);
  expect(await restored.getByRole('link', { name: /Open source record/ }).getAttribute('href') === href).toBe(true);
});
