import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Bug bash repro (charters doc + V1 finding; fixed on main by #114 ca78d88, not yet
// deployed to staging e5d664b): with no local Quill companion reachable, the Call
// mode button stays visible and its dialog offers start controls marked "Ready".
test('[call-mode-open] Call mode is hidden when the local Quill companion is unreachable', { session: 'staging-partner', tags: ['bugbash'] }, async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('main').first()).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Call mode' })).toBeHidden();
});
