import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Repro: /search says "Search temporarily unavailable" for any query that matches a deal.
// js/search-model.js DEAL_KEYS is exactly [name, phase, owner, client_ref]; the record layer's `find`
// now returns invoiced_on, closed_on, lane and outcome on each deal, so exactKeys() rejects the whole payload.
test('[search-run] a query matching a deal still shows results', { session: 'staging-partner', tags: ['bugbash', 'area-b'] }, async ({ app, screen, browser }) => {
  await app.open('/search?q=Synthetic');
  const brief = screen.getByRole('button', 'Dismiss morning brief');
  if (await brief.isVisible().catch(() => false)) await brief.tap();
  await expect(browser).toHaveURL(/q=Synthetic/);
  await expect(screen.getByText('Search temporarily unavailable')).toBeHidden();
  await expect(screen.getByRole('heading', 'Synthetic Staging Fixture').first()).toBeVisible();
});
