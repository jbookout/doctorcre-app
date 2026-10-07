import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { CONTRAST_SRC, dismissBrief } from '../v1/_h.ts';

// QA-015: the Search button label must stay readable (WCAG AA, 4.5:1) after a submit, in dark mode.
test('QA-015 Search button label contrast after submit', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await app.open('/search');
  await dismissBrief(screen);
  await expect(browser.locator('html')).toBeAttached();
  await screen.getByLabel('Name to search').fill('zzqa-no-such-record');
  await screen.getByRole('button', 'Search', { exact: true }).tap();
  await expect(screen.getByRole('heading', 'No matches')).toBeVisible();
  const rows: Array<{ ratio: number; fg: string }> = await browser.evaluate(CONTRAST_SRC, { text: 'Search', selector: '#searchForm button' });
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.ratio, `Search label ${row.fg}`).toBeGreaterThanOrEqual(4.5);
});
