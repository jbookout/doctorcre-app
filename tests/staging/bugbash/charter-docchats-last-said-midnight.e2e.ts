import { expect, unique } from 'e2e';
import { verbTest as test } from '../api/fixture.ts';

// Bug bash repro (area C journey docchats-create, 2026-10-07; js/conversations.js:208
// renders `last said ${formatClock(row.latest_turn_at)}`): a conversation created a
// moment ago, with no turns, is listed as "last said 12:00 AM". Every conversation on
// staging shows the same midnight time.
test('[docchats-create] a new conversation with no turns does not claim it last spoke at midnight', { session: 'staging-partner', tags: ['bugbash'] }, async ({ app, screen, verb }) => {
  const title = unique(`E2E ${Date.now()} last-said check`);
  await app.open('/doc-chats');
  const created = await verb('create-doc-conversation', { title: title.value, visibility: 'private', idempotency_key: crypto.randomUUID() });
  expect(created.isError).toBe(false);
  await app.open('/doc-chats');
  const entry = screen.getByRole('listitem').filter({ hasText: title.value }).first();
  await expect(entry).toBeVisible();
  await expect(entry).not.toContainText('last said 12:00 AM');
});
