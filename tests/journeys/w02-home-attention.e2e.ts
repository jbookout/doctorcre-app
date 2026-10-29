import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// W2: Home lists overdue local deals, most overdue first; a row opens that exact deal.
test('W2 Home lists overdue local deals, scopes to the viewer and opens the exact deal', async ({ app, browser, screen }) => {
  await app.open('/');

  const flags = browser.locator('#dealFlags .home-flag');
  await expect(flags).toContainText(['Demo Specialty Clinic', 'Demo Osteopathic Office', 'Demo Surgical Practice']);
  await expect(flags).toHaveCount(3);

  await screen.getByRole('button', 'Just me', { exact: true }).tap();
  await expect(screen.getByRole('button', 'Just me', { exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(flags).toHaveCount(2);
  await screen.getByRole('button', 'Team view', { exact: true }).tap();
  await expect(flags).toHaveCount(3);

  const dealLink = browser.locator('#dealFlags .home-flag h3 a').first();
  await expect(dealLink).toHaveAttribute('href', '/deals?deal=d23');
  await dealLink.tap();
  await browser.waitForURL(/\/deals\?deal=d23$/);
  await expect(browser.locator('#panelTitle')).toContainText('Demo Specialty Clinic');
  await expect(browser.locator('#detailUpdateForm')).toBeVisible();
  await browser.locator('#panelClose').tap();
  await expect(browser.locator('#recordPanel')).toBeHidden();
});
