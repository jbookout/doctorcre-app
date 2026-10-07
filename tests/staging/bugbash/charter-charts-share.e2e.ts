import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Bug bash repro (charter people-design, confirmed by DOM probe 2026-10-07):
// every chart table on /?view=charts has a SHARE column whose cells are empty.
test('[charts-pick-slice] chart tables fill the Share column for each row', { session: 'staging-partner', tags: ['bugbash'] }, async ({ app, screen }) => {
  await app.open('/?view=charts');
  const phase = screen.getByRole('table', { name: /By phase/ });
  // Row: Phase (row header) | Records | Share. A row that holds records must state its share.
  const withRecords = phase.getByRole('row').filter({ has: screen.getByRole('cell', { name: /^[1-9]\d*$/ }) }).first();
  await expect(withRecords).toBeVisible();
  await expect(withRecords.getByRole('cell').nth(1)).toHaveText(/\d+\s*%/);
});
