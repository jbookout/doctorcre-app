import { test } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import { dismissMorningBrief } from '../support/brief.ts';

// Bug bash repro (area C2, pw-sessions): Project activity > Session lookup for a
// session that does not exist shows only the generic empty state ("No linked
// native session is available in this read. Use lookup for an explicit
// session."), which tells the partner to do what they just did. The Control Room
// Sessions tab says "No session matches that." for the same lookup.
test('[pw-sessions] a lookup that finds nothing says no session matches', { session: 'staging-partner', tags: ['bugbash'] }, async ({ app, screen }) => {
  const name = unique(`e2e-no-such-session-${Date.now()}`);
  await app.open('/control-room/progress/work');
  await dismissMorningBrief(screen);
  await screen.getByLabel('Session lookup').fill(name.value);
  await screen.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(screen.getByText(/lookup results/i)).toBeVisible();
  await expect(screen.getByText(/no sessions? (matches|found)|did not match|nothing matches/i).first()).toBeVisible();
});
