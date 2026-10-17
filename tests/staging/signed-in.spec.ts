import { test, expect } from '@playwright/test';

test('signed-in partner visits the main screens and retains the session after reload', async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => {
    await dismiss.click();
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Joe: account and settings', exact: true })).toBeVisible();

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
    await test.step(screen.name, async () => {
      const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
      if (screen.more) await navigation.getByRole('button', { name: 'More', exact: true }).click();
      await navigation.getByRole('link', { name: screen.name, exact: true }).click();
      await expect(page).toHaveURL(screen.path);
      await expect(page).toHaveTitle(screen.title);
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Joe: account and settings', exact: true })).toBeVisible();
    });
  }

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Joe: account and settings', exact: true }).click();
  await expect(page.getByText("Joe's Workspace", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});
