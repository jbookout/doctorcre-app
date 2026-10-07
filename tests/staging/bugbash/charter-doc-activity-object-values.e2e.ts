import { expect } from 'e2e';
import { verbTest as test } from '../api/fixture.ts';

// Bug bash repro (coordinator probe 2026-10-07; js/doc-activity-model.js validRow on
// staging e5d664b and main): parking a deal records an "operating state changed"
// entry whose before/after are objects ({ state, reason, note }). The client accepts
// only scalar before/after, rejects the WHOLE answer and shows "Activity temporarily
// unavailable", so one parked deal hides every partner's Doc Activity until that
// entry ages out of the 50-entry window.
test('[activity-filters] Doc Activity lists entries when the record layer returns them', { session: 'staging-partner', tags: ['bugbash'] }, async ({ app, screen, verb }) => {
  await app.open('/doc-activity');
  const answer = await verb('read-doc-activity', { limit: 50 });
  expect(answer.data.ok).toBe(true);
  const objectValued = answer.data.entries.filter((row: { before: unknown; after: unknown }) => typeof row.before === 'object' && row.before !== null || typeof row.after === 'object' && row.after !== null);
  test.skip(objectValued.length === 0, 'precondition: no object-valued activity entry in the latest 50 (park a deal to recreate it)');
  const first = answer.data.entries[0];
  await expect(screen.getByRole('button', { name: `${first.what}: ${first.record.name}` }).first()).toBeVisible({ timeout: 20_000 });
});
