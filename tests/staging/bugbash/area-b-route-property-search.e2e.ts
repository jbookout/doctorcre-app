import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Repro: the "Find properties" discovery section ships with a static `hidden` attribute
// (tours/route-editor.html <section hidden class="discovery">) and no script ever un-hides it,
// so a partner can never reach property search from the route editor.
test('[route-property-search] Find properties is reachable after opening a tour', { session: 'staging-partner', tags: ['bugbash', 'area-b'] }, async ({ app, screen }) => {
  await app.open('/tours/route-editor.html');
  const brief = screen.getByRole('button', 'Dismiss morning brief');
  if (await brief.isVisible().catch(() => false)) await brief.tap();
  await screen.getByRole('button').filter({ hasText: 'draft' }).first().tap();
  await expect(screen.getByRole('heading', 'Tour composer')).toBeVisible();
  await expect(screen.getByRole('button', 'Find properties')).toBeVisible();
});
