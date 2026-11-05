import { test as setup } from '@playwright/test';
import { chmod, mkdir, open } from 'node:fs/promises';
import { sessionDirectory, sessionFile } from './session';

setup('save human sign-in session', async ({ page }) => {
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await chmod(sessionDirectory, 0o700);
  await page.goto('/auth/login');
  await page.waitForURL(url => url.origin === 'https://app.doctorcre.com' && !url.pathname.startsWith('/auth/'), { timeout: 300_000 });
  await page.getByRole('button', { name: 'Account and settings', exact: true }).waitFor();
  const file = await open(sessionFile, 'w', 0o600);
  await file.chmod(0o600);
  await file.close();
  await page.context().storageState({ path: sessionFile });
  await chmod(sessionFile, 0o600);
});
