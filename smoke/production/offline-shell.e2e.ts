import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The public shell a lost connection falls back to must be served by the
// release, with its own heading, so a dropped network never shows a blank page.
test('production offline shell is served by the release', async ({ app, screen }) => {
  await app.open('/offline.html');

  await expect(screen.getByRole('heading', 'Reconnecting…')).toBeVisible();
  await app.screenshot('offline-shell');
});
