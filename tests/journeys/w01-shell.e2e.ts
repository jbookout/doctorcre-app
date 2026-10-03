import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// W1: the shell names the signed-in viewer, shows when data last synced, keeps
// its controls across a reload and signs out through the account menu.
test('W1 shell shows freshness and keeps its controls across a reload', async ({ app, browser, screen }) => {
  await app.open('/?actor=dell');

  await expect(browser.locator('#selfAvatar')).toHaveText('D');
  await expect(browser.locator('#appSyncTime')).toHaveText(/^\d{1,2}:\d{2} (AM|PM)$/);
  await expect(screen.getByLabel('Dark mode', { exact: true })).toHaveAttribute('aria-pressed', 'true');

  await screen.getByLabel('Dark mode', { exact: true }).tap();
  await expect(browser.locator('html')).toHaveAttribute('data-theme', 'light');
  await browser.reload();
  await expect(browser.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(browser.locator('#appSyncTime')).toHaveText(/^\d{1,2}:\d{2} (AM|PM)$/);
});

// Local live mode reads the cookie session; this one is synthetic.
test('W1 a live session signs in as its partner and signs out with its token', async ({ app, browser, screen }) => {
  const signOuts: string[] = [];
  await browser.route('**/api/system-work/session', route =>
    route.fulfill({ json: { actor: { slug: 'dell' }, csrf_token: 'synthetic-e2e-token' } }));
  await browser.route('**/auth/signout', route => {
    signOuts.push(route.request.headers['x-carr-csrf'] ?? '');
    return route.fulfill({ status: 204 });
  });
  await browser.route('**/auth/login', route => route.fulfill({ headers: { 'content-type': 'text/html' }, body: '<h1>Signed out</h1>' }));
  await app.open('/?mode=live');

  await expect(browser.locator('#selfAvatar')).toHaveText('D');
  await expect(browser.locator('#selfAvatar')).toHaveAttribute('aria-label', 'Dell: account and settings');
  await browser.locator('#selfAvatar').tap();
  await expect(browser.locator('#accountMenu')).toBeVisible();
  await screen.getByText('Sign out', { exact: true }).tap();
  await browser.waitForURL(/\/auth\/login$/);
  await expect(screen.getByRole('heading', 'Signed out')).toBeVisible();
  expect(signOuts).toEqual(['synthetic-e2e-token']);
});
