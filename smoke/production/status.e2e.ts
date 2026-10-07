import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The one page served ahead of the CARR gate. Its own scripts must load under
// the production CSP, read /app-release from the browser and paint a headline.
test('production status page renders signed out and reads the app release', async ({ app, browser, screen }) => {
  await app.open('/status');

  await expect(screen.getByRole('heading', 'Status')).toBeVisible();
  await expect(browser.locator('#statusHeadline')).not.toHaveText('Updating…');
  await expect(browser.locator('#statusHeadline')).not.toHaveText(/The DoctorCRE app itself did not answer/);
  await app.screenshot('status');
});
