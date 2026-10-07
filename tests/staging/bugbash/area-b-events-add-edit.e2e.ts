import { randomUUID } from 'node:crypto';
import { expect } from 'e2e';
import { verbTest as test } from '../api/fixture.ts';

// Repro: the Events tab reads "Events temporarily unavailable" as soon as one industry event exists.
// js/ideas-model.js eventReadState() requires Number.isInteger(row.version), but list-industry-events
// returns version as a string ("1"), so every non-empty answer is rejected as an error.
test('[events-add-edit] an existing event shows in the Events list', { session: 'staging-partner', tags: ['bugbash', 'area-b'] }, async ({ app, screen, verb }) => {
  const title = `E2E ${Date.now()} repro event`;
  const added = await verb('add-industry-event', { idempotency_key: randomUUID(), title, organizer: 'E2E Org', kind: 'conference', starts_at: '2026-12-03T14:00:00-06:00', ends_at: '2026-12-03T16:00:00-06:00', owner_partner: 'joe', source: 'e2e repro' });
  expect(added.data.ok).toBe(true);
  await app.open('/ideas-events?tab=events');
  const brief = screen.getByRole('button', 'Dismiss morning brief');
  if (await brief.isVisible().catch(() => false)) await brief.tap();
  await expect(screen.getByText('Events temporarily unavailable')).toBeHidden();
  await expect(screen.getByRole('button').filter({ hasText: title }).first()).toBeVisible();
  await verb('update-industry-event', { idempotency_key: randomUUID(), event_id: added.data.event.id, base_version: Number(added.data.event.version), status: 'cancelled' });
});
