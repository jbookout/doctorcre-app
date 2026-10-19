import { test, expect } from '@playwright/test';

const screens = [
  { name: 'Leads', path: '/leads', title: 'Leads · DoctorCRE', more: false },
  { name: 'Tours', path: '/tours', title: 'Tours · DoctorCRE', more: false },
  { name: 'Local Deals', path: '/deals', title: 'Local Deals · DoctorCRE', more: false },
  { name: 'Vendors', path: '/vendors', title: 'Vendors · DoctorCRE', more: false },
  { name: 'Control Room', path: '/control-room', title: 'Control Room · DoctorCRE', more: false },
  { name: 'Relationships', path: '/relationships', title: 'Relationships · DoctorCRE', more: true },
  { name: 'Invoices', path: '/invoices', title: 'Invoices · DoctorCRE', more: true },
  { name: 'Home', path: '/', title: 'Home · DoctorCRE', more: false },
];

for (const screen of screens) {
  test(`signed-in partner navigates to ${screen.name} and retains the session after reload`, async ({ page }, testInfo) => {
    await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => {
      await dismiss.click();
    });
    const account = page.getByRole('button', { name: 'Joe: account and settings', exact: true });
    const visit = async (navigate: () => Promise<unknown>) => {
      const identity = page.waitForResponse('**/api/system-work/session');
      await navigate();
      expect((await identity).status()).toBe(200);
      await expect(account).toBeVisible();
    };
    await visit(() => page.goto(screen.path === '/' ? '/leads' : '/'));
    const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
    if (screen.more) {
      const more = navigation.getByRole('button', { name: 'More', exact: true });
      await more.click();
      await expect(more).toHaveAttribute('aria-expanded', 'true');
    }
    await visit(() => navigation.getByRole('link', { name: screen.name, exact: true }).click());
    await expect(page).toHaveURL(screen.path);
    await expect(page).toHaveTitle(screen.title);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(account).toBeVisible();

    await visit(() => page.reload());
    await expect(page).toHaveURL(screen.path);
    await expect(page).toHaveTitle(screen.title);
    await account.click();
    await expect(page.getByText("Joe's Workspace", { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('signed-in-route.png') });
  });
}
