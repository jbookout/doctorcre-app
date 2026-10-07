import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissMorningBrief } from '../support/brief.ts';

// Bug bash repro (charter people-design, confirmed by DOM probe 2026-10-07):
// in Design Lab > Components, pressing the "Other" sample tab leaves "Selected"
// selected and the sample panel unchanged.
test('[design-tabs] the Other sample tab selects and shows the other sample', { session: 'staging-partner', tags: ['bugbash'] }, async ({ app, screen }) => {
  await app.open('/design-lab');
  await dismissMorningBrief(screen);
  await screen.getByRole('tab', { name: 'Components' }).click();
  await expect(screen.getByRole('tab', { name: 'Components' })).toHaveAttribute('aria-selected', 'true');
  await screen.getByRole('tab', { name: 'Other' }).click();
  await expect(screen.getByRole('tab', { name: 'Other' })).toHaveAttribute('aria-selected', 'true');
});
