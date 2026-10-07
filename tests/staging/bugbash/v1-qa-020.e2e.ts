import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief } from '../v1/_h.ts';

// QA-020: submitting a cleared search must drop the old ?q= from the address.
test('QA-020 cleared search removes the old query from the URL', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await app.open('/search');
  await dismissBrief(screen);
  const box = screen.getByLabel('Name to search');
  await box.fill('zzqa-no-such-record');
  await screen.getByRole('button', 'Search', { exact: true }).tap();
  await expect(browser).toHaveURL(/\/search\?q=zzqa-no-such-record/);
  await expect(screen.getByRole('heading', 'No matches')).toBeVisible();

  await box.clear();
  await screen.getByRole('button', 'Search', { exact: true }).tap();
  await expect(screen.getByRole('heading', 'Search by name')).toBeVisible();
  expect(await browser.url(), 'address after submitting an empty search').not.toContain('q=zzqa-no-such-record');
});
