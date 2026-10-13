import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { RELEASE_IDENTITY } from './release-identity.mjs';

// The one page served ahead of the CARR gate. Its own scripts must load under
// the production CSP, read /app-release from the browser, paint a headline and
// show the release identity that answered.
test('production status page renders signed out and reads the app release', async ({ app, browser, screen }) => {
  await app.open('/status');

  await expect(screen.getByRole('heading', 'Status')).toBeVisible();
  await expect(browser.locator('#statusHeadline')).not.toHaveText('Updating…');
  await expect(browser.locator('#statusHeadline')).not.toHaveText(/The DoctorCRE app itself did not answer/);
  await expect(browser.locator('#statusIdentity')).toHaveText(RELEASE_IDENTITY);
  await app.screenshot('status');
});
