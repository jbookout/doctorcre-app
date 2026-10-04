import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// W2: Home lists the deals that need attention; a flag opens that exact deal.
test('W2 Home attention lists flagged deals, scopes to the viewer and opens the exact deal', async ({ app, browser, screen }) => {
  await app.open('/');

  const flags = browser.locator('#dealFlags .home-flag');
  await expect(flags).toContainText(['Demo Dental North', 'Demo Vision Center', 'Demo Family Clinic', 'Demo Specialty Clinic']);
  await expect(flags).toHaveCount(4);

  await screen.getByRole('button', 'Just Me', { exact: true }).tap();
  await expect(screen.getByRole('button', 'Just Me', { exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(flags).toHaveCount(2);
  await screen.getByRole('button', 'Team View', { exact: true }).tap();
  await expect(flags).toHaveCount(4);

  await expect(flags.first()).toHaveAttribute('href', '/deals?deal=d01');
  await flags.first().tap();
  await browser.waitForURL(/\/deals\?deal=d01$/);
  await expect(browser.locator('#panelTitle')).toContainText('Demo Dental North');
  await expect(browser.locator('#detailNextForm')).toBeVisible();
});
