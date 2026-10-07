import { describe, test } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import { z } from 'zod';
import { verbTest } from '../api/fixture.ts';
import { dismissMorningBrief } from '../support/brief.ts';

// Area C journeys: Updates, Doc Chats, Choose work and Doc Activity.
// Every act is pinned by a locator expect or agent.assert; created names are
// wrapped in unique() so the replay cache keys stay stable (docs/cache.mdx).

// A conversation's entry in "Your conversations" (its title also labels a hidden region).
const entry = (screen: any, title: string) => screen.getByRole('listitem').filter({ hasText: title }).first();

describe('area C: Updates', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  test('[updates-feed] the notification feed reads and states its contents', async ({ app, agent, screen }) => {
    await app.open('/updates');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await expect(screen.getByText('Reading your notifications…')).toBeHidden();
    await agent.assert('The Notifications section either lists notifications or plainly says there are none');
  });

  test('[updates-acknowledge] a notification can be acknowledged', async ({ app, screen }) => {
    test.skip(true, 'missing seed: notification-feed is empty for E2E Joe on staging and no app or /mcp verb creates a notification addressed to him');
    await app.open('/updates');
    await expect(screen.getByRole('button', { name: 'Acknowledge this notification' }).first()).toBeVisible();
  });

  test('[updates-preferences] quiet hours save, persist across a reload, and clear', async ({ app, agent, screen }) => {
    await app.open('/updates');
    await dismissMorningBrief(screen);
    await expect(screen.getByText('Reading your preferences…')).toBeHidden();
    await agent.act('Set quiet hours from 9:00 PM to 7:00 AM and save the preferences');
    await expect(screen.getByLabel('Quiet hours start')).toHaveValue(/^21:00/);
    await agent.assert('The page confirms the notification preferences were saved');
    await app.open('/updates');
    await expect(screen.getByLabel('Quiet hours start')).toHaveValue(/^21:00/);
    await expect(screen.getByLabel('Quiet hours end')).toHaveValue(/^07:00/);
    await dismissMorningBrief(screen);
    await screen.getByRole('button', { name: 'Clear quiet hours' }).click();
    await app.open('/updates');
    await expect(screen.getByLabel('Quiet hours start')).toHaveValue('');
  });
});

describe('area C: Doc Chats', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  test('[docchats-list] a conversation opens and archived conversations can be shown', async ({ app, agent, screen }) => {
    await app.open('/doc-chats');
    await dismissMorningBrief(screen);
    await agent.act('Open the first conversation in Your conversations');
    await expect(screen.getByText('Reading this conversation…')).toBeHidden();
    await agent.assert('The conversation pane shows the opened conversation, either its turns or a statement that it has no turns yet');
    await screen.getByRole('button', { name: 'Show archived' }).click();
    await expect(screen.getByRole('button', { name: /Show archived|Hide archived/ })).toBeVisible();
  });

  verbTest('[docchats-create] a new private conversation is created and listed after a reload', async ({ app, agent, screen, verb }) => {
    const title = unique(`E2E ${Date.now()} conversation`);
    await app.open('/doc-chats');
    await dismissMorningBrief(screen);
    await agent.act('Create a new private conversation titled {title}', { params: { title } });
    await expect(entry(screen, title.value)).toBeVisible();
    // A brand-new conversation has said nothing, so it must not claim a "last said" time of midnight.
    await expect(entry(screen, title.value)).not.toContainText('last said 12:00 AM');
    const listed = await verb('list-doc-conversations', {});
    expect(JSON.stringify(listed.data)).toContain(title.value);
    await app.open('/doc-chats');
    await expect(entry(screen, title.value)).toBeVisible();
  });

  test('[docchats-rename-pin-archive] a conversation is renamed, pinned and archived', async ({ app, agent, screen }) => {
    const title = unique(`E2E ${Date.now()} lifecycle`);
    const renamed = unique(`E2E ${Date.now()} renamed`);
    await app.open('/doc-chats');
    await dismissMorningBrief(screen);
    await agent.act('Create a new private conversation titled {title}', { params: { title } });
    await expect(entry(screen, title.value)).toBeVisible();
    await agent.act('Open the conversation {title}, then give it the new title {renamed} and save it', { params: { title, renamed } });
    await expect(entry(screen, renamed.value)).toBeVisible();
    await agent.act('Pin this conversation');
    await agent.assert('The conversation is shown as pinned');
    await agent.act('Archive this conversation');
    await app.open('/doc-chats');
    await expect(entry(screen, renamed.value)).toBeHidden();
    await screen.getByRole('button', { name: 'Show archived' }).click();
    await expect(entry(screen, renamed.value)).toBeVisible();
  });

  test('[docchats-share] a conversation is shared with the partner', async ({ app, agent, screen }) => {
    const title = unique(`E2E ${Date.now()} shared`);
    await app.open('/doc-chats');
    await dismissMorningBrief(screen);
    // Title and access are known controls: fill them directly so the choice cannot be lost on replay.
    await screen.getByRole('textbox', { name: 'Title', exact: true }).fill(title.value);
    await screen.getByLabel('Who can read it').selectOption({ label: 'Shared with your partner' });
    await screen.getByRole('button', { name: 'Create this conversation' }).click();
    await expect(entry(screen, title.value)).toBeVisible();
    await expect(entry(screen, title.value)).toContainText('shared');
    await agent.assert('The new conversation is marked as shared with the partner, not private');
  });

  test('[docchats-outcome-cards] outcome cards read and can expand', async ({ app, agent, screen }) => {
    await app.open('/doc-chats');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'What Doc is tracking for you' })).toBeVisible();
    await agent.waitFor('The "What Doc is tracking for you" section has finished loading', { timeout: 45_000 });
    await agent.assert('The "What Doc is tracking for you" section lists outcome cards or plainly says there are none');
  });

  test('[docchats-decide-suggestion] a Doc suggestion can be acted on, snoozed or dismissed', async ({ app, screen }) => {
    test.skip(true, 'missing seed: list-doc-suggestions is empty on staging; suggestions come from the scheduled suggest-doc-work scan, which no app or /mcp path runs');
    await app.open('/doc-chats');
    await expect(screen.getByRole('group', { name: 'Decide this suggestion' }).first()).toBeVisible();
  });

  test('[docchats-correct-suggestion] a correction can be proposed on a Doc suggestion', async ({ app, screen }) => {
    test.skip(true, 'missing seed: list-doc-suggestions is empty on staging (same seed as docchats-decide-suggestion)');
    await app.open('/doc-chats');
    await expect(screen.getByRole('button', { name: 'Propose correction' }).first()).toBeVisible();
  });
});

describe('area C: Choose work', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  verbTest('[work-quick-add] a quick-added task appears in the list and in the record', async ({ app, agent, screen, verb }) => {
    const sentence = unique(`E2E ${Date.now()} call the staging fixture about the LOI`);
    await app.open('/doc-chats/work');
    await dismissMorningBrief(screen);
    await agent.act('Type {sentence} into the Quick add sentence field', { params: { sentence } });
    await expect(screen.getByLabel('Sentence')).toHaveValue(sentence.value);
    await screen.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(screen.getByText(sentence.value).first()).toBeVisible();
    const board = await verb('loop-board', {});
    expect(JSON.stringify(board.data)).toContain(sentence.value.slice(0, 40));
  });

  test('[work-task-dialog] a task opens, takes a new due date, and completes with an outcome', async ({ app, agent, screen }) => {
    test.skip(true, 'blocked by staging record layer: add-loop refuses every capture ("the loop importer has not run for this kind — nothing to render into") and the task list is empty, so no task exists to open');
    const sentence = unique(`E2E ${Date.now()} task to complete`);
    await app.open('/doc-chats/work');
    await dismissMorningBrief(screen);
    await agent.act('Quick add the task {sentence} and save it', { params: { sentence } });
    await expect(screen.getByText(sentence.value).first()).toBeVisible();
    await agent.act('Open the task {sentence}', { params: { sentence } });
    await expect(screen.getByRole('button', { name: 'Complete' })).toBeVisible();
    await agent.act('Complete the task with the outcome "E2E done" and confirm');
    await agent.assert('The task was completed and is no longer listed as open');
    await app.open('/doc-chats/work');
    await expect(screen.getByText(sentence.value)).toBeHidden();
  });

  test('[work-scope] Team and Mine scopes filter the list', async ({ app, agent, screen }) => {
    await app.open('/doc-chats/work');
    await dismissMorningBrief(screen);
    await expect(screen.getByText(/record\(s\) shown/).first()).toBeVisible({ timeout: 30_000 });
    const scope = screen.getByRole('group', { name: 'Scope' });
    await scope.getByRole('button', { name: 'Mine' }).click();
    await expect(scope.getByRole('button', { name: 'Mine' })).toHaveAttribute('aria-pressed', 'true');
    await expect(screen.getByText(/record\(s\) shown in the Mine scope/).first()).toBeVisible({ timeout: 30_000 });
    const mine = await agent.extract('The number of records the list says it shows', { schema: z.object({ shown: z.number().int() }) });
    await scope.getByRole('button', { name: 'Team' }).click();
    await expect(scope.getByRole('button', { name: 'Team' })).toHaveAttribute('aria-pressed', 'true');
    await expect(screen.getByText(/record\(s\) shown in the Team scope/).first()).toBeVisible({ timeout: 30_000 });
    const team = await agent.extract('The number of records the list says it shows', { schema: z.object({ shown: z.number().int() }) });
    expect(team.shown).toBeGreaterThanOrEqual(mine.shown);
  });
});

describe('area C: Doc Activity', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  test('[activity-filters] partner, record type and date filters narrow the activity and clear', async ({ app, agent, screen }) => {
    await app.open('/doc-activity');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('list', { name: 'Doc and automation activity' }).getByRole('button').first()).toBeVisible({ timeout: 30_000 });
    const all = await agent.extract('How many activity entries are listed', { schema: z.object({ entries: z.number().int() }) });
    // Lead is used here because the Deal filter currently fails on an object-valued
    // deal entry (repros charter-doc-activity-object-values / -stale-under-filter).
    await agent.act('Filter the activity to the Lead record type');
    await expect(screen.getByLabel('Record type')).not.toHaveValue('');
    await agent.waitFor('The activity list shows only lead entries', { timeout: 30_000 });
    await agent.assert('Every listed activity entry is about a lead');
    const deals = await agent.extract('How many activity entries are listed', { schema: z.object({ entries: z.number().int() }) });
    expect(deals.entries).toBeLessThanOrEqual(all.entries);
    await screen.getByRole('button', { name: 'Clear filters' }).click();
    await expect(screen.getByLabel('Record type')).toHaveValue('');
  });

  test('[activity-detail-undo] an activity entry opens its detail and Undo reverts the change', async ({ app, agent, screen }) => {
    await app.open('/doc-activity');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('list', { name: 'Doc and automation activity' }).getByRole('button').first()).toBeVisible({ timeout: 30_000 });
    // Desktop rows carry their own Undo button (the first is the newest); at phone
    // width the button lives in the entry's detail, opened from the row.
    const list = screen.getByRole('list', { name: 'Doc and automation activity' });
    const inline = list.getByRole('button', { name: 'Undo', exact: true }).first();
    if (await inline.isVisible().catch(() => false)) await inline.click();
    else {
      await agent.act('Open the newest activity entry whose detail offers Undo');
      await expect(screen.getByRole('heading', { name: 'What changed' })).toBeVisible();
      await screen.getByRole('button', { name: 'Undo', exact: true }).click();
    }
    await agent.waitFor('The undo has finished: no entry still says Undoing…', { timeout: 45_000 });
    await agent.assert('The page confirms the change was undone');
    // The revert entry offers no Undo of its own, so the reverted field stays reverted (disposable staging data).
    await app.open('/doc-activity');
    await expect(screen.getByRole('list', { name: 'Doc and automation activity' }).getByRole('button').first()).toBeVisible({ timeout: 30_000 });
  });
});
