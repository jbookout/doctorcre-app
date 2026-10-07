import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissMorningBrief } from '../support/brief.ts';

// Bug bash repro (area C2, allwork-records): the Open link on every All Work
// record goes to the same destination, /system-work.html, which redirects to the
// Work Requests list. GET /api/v1/work-inventory returns open: "/system-work.html"
// for all 41 staging records, so Open on WR-000144 does not open WR-000144.
test('[allwork-records] Open on a work request record opens that work request', { session: 'staging-partner', tags: ['bugbash'] }, async ({ app, browser, screen }) => {
  await app.open('/all-work');
  await dismissMorningBrief(screen);
  await expect(screen.getByText('Census complete')).toBeVisible({ timeout: 30_000 });
  const row = screen.getByRole('listitem').filter({ hasText: 'WR-000144' }).first();
  await row.getByRole('link', { name: 'Open', exact: true }).click();
  await expect(browser).toHaveURL(/WR-000144/);
});
