import { expect } from 'e2e';
import { test, seedFixture } from '../../qa/support.ts';

test('QA-023 the selected lease remains reachable after reload', { tags: ['bugbash'] }, async ({ app, browser, screen }) => {
  const seeded = await seedFixture(app.baseUrl!, 'root-lease-detail', 'joe');
  await browser.setCookies([seeded.cookie]);
  await app.open('/leases');
  await screen.getByRole('button', 'Demo Practice 3', { exact: false }).tap();
  await expect(screen.getByRole('dialog', 'Demo Practice 3')).toBeVisible();
  await browser.reload();
  await expect(screen.getByRole('dialog', 'Demo Practice 3')).toBeVisible();
});
