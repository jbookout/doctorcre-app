import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief } from '../v1/_h.ts';

// QA-009: with no conversation selected, the thread pane must prompt for a selection rather than sit on "Loading…".
test('QA-009 Doc Chats thread pane is not stuck loading with nothing selected', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await app.open('/doc-chats');
  await dismissBrief(screen);
  await screen.getByRole('button', 'Open this conversation').first().tap();
  await expect(browser).toHaveURL(/\/doc-chats\?|\/doc-chats\/|conversation=/);
  await browser.back();
  await expect(browser).toHaveURL(/\/doc-chats$/);
  await expect(screen.getByRole('heading', 'The conversation')).toBeVisible();
  const turns = () => browser.evaluate(() => document.getElementById('turnsStateTitle')?.textContent?.trim() ?? '');
  await expect.poll(turns, { message: 'thread pane state sentence after Back', timeout: 10_000 }).not.toBe('Loading…');
});
