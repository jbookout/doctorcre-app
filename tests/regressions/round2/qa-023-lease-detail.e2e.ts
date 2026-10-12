import { expect } from 'e2e';
import { reproTest } from '../support.mjs';
const test = reproTest();

test('QA-023 the selected lease remains reachable after reload', { tags: ['regression'] }, async ({ app, browser, screen }) => {
  await app.open('/leases');
  await screen.getByRole('button', 'Demo Practice 3', { exact: false }).tap();
  await expect(screen.getByRole('dialog', 'Demo Practice 3')).toBeVisible();
  await browser.reload();
  await expect(screen.getByRole('dialog', 'Demo Practice 3')).toBeVisible();
});
