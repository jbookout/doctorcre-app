import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Bug bash repro (area C journey activity-filters + coordinator probe 2026-10-07):
// choosing Record type "Deal" fails the read ("Activity temporarily unavailable",
// root cause in charter-doc-activity-object-values) and the page keeps showing the
// previous UNFILTERED rows (new lead, add party, ...) under the "Deal" label, so a
// partner reads lead activity as if it were deal activity.
test('[activity-filters] a failed filtered read does not leave unfiltered rows under the filter', { session: 'staging-partner', tags: ['bugbash'] }, async ({ app, screen }) => {
  await app.open('/doc-activity');
  const list = screen.getByRole('list', { name: 'Doc and automation activity' });
  await expect(list.getByRole('button').first()).toBeVisible({ timeout: 30_000 });
  const nonDeal = list.getByRole('button').filter({ hasText: /new lead|add party|identity changed|notification preference/ });
  test.skip((await nonDeal.count()) === 0, 'precondition: the unfiltered list holds no non-deal rows to go stale');
  await screen.getByLabel('Record type').selectOption({ label: 'Deal' });
  await expect(screen.getByLabel('Record type')).toHaveValue(/deal/i);
  await expect(screen.getByText('Updating…').first()).toBeHidden({ timeout: 30_000 });
  await expect(nonDeal).toHaveCount(0);
});
