import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissMorningBrief } from '../support/brief.ts';

// Bug bash repro (area C2, cr-job-board): on the Control Room System Job Board
// the "Stage" filter offers only "All" while the Queued column holds cards, so a
// partner cannot narrow the board to a stage. js/progress-board.js fills the
// options only when a board snapshot is published; the live work pipeline never does.
test('[cr-job-board] the Stage filter offers the stages that hold cards', { session: 'staging-partner', tags: ['bugbash'] }, async ({ app, screen }) => {
  await app.open('/control-room');
  await dismissMorningBrief(screen);
  await expect(screen.getByText(/^\d+ OF \d+ CARDS$/)).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByRole('region', { name: /^Queued: [1-9]/ })).toBeVisible();
  const filters = screen.getByRole('form', { name: 'Filter cards' });
  await expect(filters.getByLabel('Stage').getByRole('option', { name: 'Queued' })).toHaveCount(1);
});
