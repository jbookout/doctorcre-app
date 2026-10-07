import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Bug bash repro (charter phone-core; source js/boot-mode.js on staging e5d664b and
// main ca78d88): the staging host is treated as a reviewed deployment and labelled
// "LIVE · DoctorCRE" / "Connected to the live DoctorCRE Deal Room", the same words
// production shows, so a partner cannot tell staging from the real book.
test('[shell-nav] the staging deployment does not call itself the live Deal Room', { session: 'staging-partner', tags: ['bugbash'] }, async ({ app, screen }) => {
  await app.open('/deals');
  const identity = screen.getByText(/· DoctorCRE$/).first();
  await expect(identity).toBeVisible();
  await expect(identity).toContainText(/staging/i);
});
