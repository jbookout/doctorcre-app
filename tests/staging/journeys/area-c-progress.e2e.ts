import { describe } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import { z } from 'zod';
import { verbTest as test, type Verb } from '../api/fixture.ts';
import { dismissMorningBrief } from '../support/brief.ts';

// Area C2 journeys: the progress board and project activity. Staging has no
// published board snapshot, so board journeys seed their own synthetic board
// through the app's own /mcp transport (publish-board-snapshot and
// ask-board-question are ordinary partner write verbs): the board id and every
// card and question are named "E2E ...". Each act is pinned by a locator expect
// or agent.assert so the replay cache records it (docs/cache.mdx).

const BOARD = 'e2e-c2-board';
const ANSWER_BOARD = 'e2e-c2-answer-board';

type Task = Record<string, unknown>;

async function publish(verb: Verb, board: string, tasks: Record<string, Task>, title: string) {
  const read = await verb('read-progress-board', { board_id: board });
  expect(read.isError).toBe(false);
  const version = Number(read.data?.snapshot?.version ?? 0);
  const result = await verb('publish-board-snapshot', {
    idempotency_key: crypto.randomUUID(), board_id: board, base_version: version,
    snapshot: { schema: 'carr-progress-board.v2', title, project: board, kind: 'project', tasks },
  });
  expect(result.isError, JSON.stringify(result.data).slice(0, 300)).toBe(false);
}

const sections = {
  queued: { title: 'E2E queued task', status: 'queued', executor: 'codex gpt-5.3-codex high', summary: 'E2E synthetic queued task.' },
  running: { title: 'E2E running task', status: 'running', executor: 'grok build', summary: 'E2E synthetic running task.', updated_at: new Date().toISOString() },
  blocked: { title: 'E2E blocked task', status: 'blocked', executor: 'claude opus 4.8', blocked_reason: 'E2E waiting on a synthetic seed', next_action: 'E2E nothing to do, synthetic', summary: 'E2E synthetic blocked task.' },
  done: { title: 'E2E finished task', status: 'done', executor: 'codex gpt-5.3-codex high', summary: 'E2E synthetic finished task.', completed_at: new Date().toISOString(), evidence: 'E2E synthetic evidence' },
} satisfies Record<string, Task>;

describe('area C2: progress board', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  test('[pb-masthead] the masthead switches between Project and All repositories and shows the Key', async ({ app, agent, browser, screen, verb }) => {
    await publish(verb, BOARD, { 'e2e-queued': sections.queued }, 'E2E C2 board');
    await app.open('/control-room/progress/board/carr-v5');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('link', { name: 'Project', exact: true })).toBeVisible();
    await expect(screen.getByRole('link', { name: 'All repositories', exact: true })).toBeVisible();
    await agent.act('Open All repositories from the board switch');
    await expect(browser).toHaveURL(/\/board\/all-repos/);
    await expect(screen.getByText(/Project board/).first()).toBeVisible();
    await screen.getByRole('link', { name: 'Project', exact: true }).click();
    await expect(browser).toHaveURL(/\/board\/carr-v5/);
    await expect(screen.getByText(/System board/).first()).toBeVisible();
    await agent.act('Press the Key button');
    await agent.assert('A key explaining stage colours, executor glyphs, pulse speeds and marks is open');
    await screen.getByRole('button', { name: 'Key' }).click();
    // Published boards lists the board this test seeded, and the directory verb agrees.
    const directory = await verb('list-progress-boards', {});
    expect(JSON.stringify(directory.data)).toContain(BOARD);
    await app.open('/control-room/progress');
    await screen.getByText('Published boards').click();
    await expect(screen.getByRole('link', { name: /E2E C2 board/ }).first()).toBeVisible();
  });

  test('[pb-sections] a published board shows its sections, counts and filters', async ({ app, agent, screen, verb }) => {
    await publish(verb, BOARD, { 'e2e-queued': sections.queued, 'e2e-running': sections.running, 'e2e-blocked': sections.blocked, 'e2e-done': sections.done }, 'E2E C2 board');
    await app.open(`/control-room/progress/board/${BOARD}`);
    await dismissMorningBrief(screen);
    await expect(screen.getByText(`${BOARD} · Published`, { exact: false })).toBeVisible({ timeout: 30_000 });
    for (const name of ['The path to live', 'Blocked, with the next action', 'Questions waiting on you', 'Executor ledger', 'Latest deliverables', 'Decisions made', 'Notes', 'Completed history']) {
      await expect(screen.getByRole('heading', { name })).toBeVisible();
    }
    const cards = screen.getByText(/^\d+ OF \d+ CARDS$/);
    await expect(cards).toHaveText('4 OF 4 CARDS');
    const counts = await agent.extract('The number of cards in each stage column (Queued, Building, Review, CI, Merged, Live)', { schema: z.object({ queued: z.number().int(), building: z.number().int(), review: z.number().int(), live: z.number().int() }) });
    expect(counts.queued).toBe(1);
    expect(counts.building).toBe(1);
    expect(counts.review).toBe(1);
    expect(counts.live).toBe(1);
    await agent.act('Filter the board to the Queued stage');
    await expect(screen.getByLabel('Stage')).toHaveValue('queued');
    await expect(cards).toHaveText('1 OF 4 CARDS');
    await screen.getByLabel('Stage').selectOption('All');
    await agent.act('Turn on Blocked only');
    await expect(screen.getByLabel('Blocked only')).toBeChecked();
    await expect(cards).toHaveText('1 OF 4 CARDS');
    await agent.assert('Only the E2E blocked task is listed under The path to live');
    await screen.getByLabel('Blocked only').uncheck();
    await expect(cards).toHaveText('4 OF 4 CARDS');
    // The blocked section names why and what happens next.
    await expect(screen.getByText('Why: E2E waiting on a synthetic seed').first()).toBeVisible();
    await expect(screen.getByText('Next: E2E nothing to do, synthetic').first()).toBeVisible();
  });

  test('[pb-task-detail] a board card opens its work detail with the published task facts', async ({ app, agent, browser, screen, verb }) => {
    await publish(verb, BOARD, { 'e2e-queued': sections.queued, 'e2e-blocked': sections.blocked }, 'E2E C2 board');
    await app.open(`/control-room/progress/board/${BOARD}`);
    await dismissMorningBrief(screen);
    await expect(screen.getByText('2 OF 2 CARDS')).toBeVisible({ timeout: 30_000 });
    await agent.act('Open the work detail of the card E2E blocked task');
    await expect(browser).toHaveURL(/\/control-room\/progress\/work\?.*task=e2e-blocked/);
    await expect(screen.getByText('Published task')).toBeVisible();
    await expect(screen.getByText('E2E blocked task').first()).toBeVisible();
    await agent.assert('The work detail shows the E2E blocked task with its stage, its model line and the reason it is blocked');
    await expect(screen.getByText('E2E waiting on a synthetic seed').first()).toBeVisible();
    await screen.getByRole('link', { name: 'E2E C2 board' }).click();
    await expect(browser).toHaveURL(new RegExp(`/control-room/progress/board/${BOARD}`));
  });

  test('[pb-answer-question] a board question is answered, shows Sent, and the answer is in the record', async ({ app, agent, screen, verb }) => {
    const stamp = Date.now();
    const prompt = unique(`E2E ${stamp} harmless question: pick one`);
    const questionId = `e2e-q-${stamp}`;
    await publish(verb, ANSWER_BOARD, { 'e2e-asked': { ...sections.blocked, title: 'E2E asked task', question_ids: [questionId] } }, 'E2E C2 answer board');
    const asked = await verb('ask-board-question', { idempotency_key: crypto.randomUUID(), board_id: ANSWER_BOARD, question_id: questionId, base_version: 0, prompt: prompt.value, choices: ['Yes', 'No'], allow_free_text: false, asker_ref: 'e2e-c2' });
    expect(asked.isError, JSON.stringify(asked.data).slice(0, 300)).toBe(false);
    await app.open(`/control-room/progress/board/${ANSWER_BOARD}`);
    await dismissMorningBrief(screen);
    const card = screen.getByRole('article').filter({ hasText: prompt.value });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText('Waiting', { exact: true })).toBeVisible();
    await agent.act('Choose Yes for the question {prompt} and press Send answer', { params: { prompt } });
    await expect(card.getByText(/^(Sent|Received|Applied)$/)).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText('Answered by joe')).toBeVisible();
    const read = await verb('read-progress-board', { board_id: ANSWER_BOARD });
    const row = (read.data?.questions ?? []).find((q: any) => q.question_id === questionId);
    expect(row?.answer_text).toBe('Yes');
    expect(['Sent', 'Received', 'Applied']).toContain(row?.status);
    await app.open(`/control-room/progress/board/${ANSWER_BOARD}`);
    await expect(screen.getByRole('article').filter({ hasText: prompt.value }).getByText('Yes', { exact: true })).toBeVisible({ timeout: 30_000 });
  });
});

describe('area C2: project activity', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  test('[pw-sessions] session lookup reports a missing session plainly, and the verb agrees', async ({ app, agent, screen, verb }) => {
    const name = unique(`e2e-no-such-session-${Date.now()}`);
    await app.open('/control-room/progress/work');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'Sessions and builders' })).toBeVisible();
    await agent.act('Type {name} into Session lookup and press Find', { params: { name } });
    await expect(screen.getByLabel('Session lookup')).toHaveValue(name.value);
    // A lookup that finds nothing must say so; the generic "use lookup" empty state is not an answer to a lookup.
    await expect(screen.getByText(/lookup results/i)).toBeVisible();
    await expect(screen.getByText(/no sessions? (matches|found)|did not match|nothing matches/i).first()).toBeVisible();
    const answer = await verb('read-session-identity', { query: name.value, limit: 5 });
    expect(answer.isError).toBe(false);
    expect(JSON.stringify(answer.data)).not.toContain(name.value + '"');
  });

  test('[pw-queue-add] read-only work added to the queue is acknowledged and reaches the room', async ({ app, agent, screen, verb }) => {
    const title = unique(`E2E ${Date.now()} read-only check, no action needed`);
    await app.open('/control-room/progress/work');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'Add read-only work' })).toBeVisible();
    await agent.act('Type {title} into the Title field under Add read-only work and press Add task', { params: { title } });
    await expect(screen.getByText('Task submitted; waiting for the board to update.')).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByLabel('Title')).toHaveValue('');
    const latest = await verb('read-room-latest', { room: 'model-room', limit: 50, mode: 'all' });
    expect(JSON.stringify(latest.data)).toContain(title.value);
  });

  test('[pw-wire] the wire filters narrow the feed and a spoken turn lands on the wire and in the record', async ({ app, agent, screen, verb }) => {
    const message = unique(`E2E ${Date.now()} wire check, read-only, no action needed`);
    await app.open('/control-room/progress/work');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('button', { name: 'Conversation' })).toHaveAttribute('aria-pressed', 'true');
    await screen.getByRole('button', { name: 'Everything' }).click();
    await expect(screen.getByRole('button', { name: 'Everything' })).toHaveAttribute('aria-pressed', 'true');
    await screen.getByRole('button', { name: 'Conversation' }).click();
    await expect(screen.getByRole('button', { name: 'Conversation' })).toHaveAttribute('aria-pressed', 'true');
    // Send stays disabled until there is something to say.
    await expect(screen.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await agent.act('Speak into the room by typing {message} and pressing Send', { params: { message } });
    await expect(screen.getByRole('log').getByText(message.value)).toBeVisible({ timeout: 30_000 });
    const latest = await verb('read-room-latest', { room: 'model-room', limit: 50, mode: 'conversation' });
    expect(JSON.stringify(latest.data)).toContain(message.value);
    // Text filter narrows the feed to the matching turn and clearing it restores the rest.
    await screen.getByLabel('Filter the wire by text').fill(message.value);
    await expect(screen.getByRole('log').getByText(message.value)).toBeVisible();
    await expect(screen.getByRole('log').getByText(/E2E agent room test/)).toBeHidden();
    await screen.getByLabel('Filter the wire by text').fill('');
    await expect(screen.getByLabel('Filter the wire by text')).toHaveValue('');
    const listed = await agent.extract('How many turns are listed in the wire feed', { schema: z.object({ turns: z.number().int() }) });
    expect(listed.turns).toBeGreaterThanOrEqual(1);
    await expect(screen.getByRole('log').getByText(message.value)).toBeVisible();
  });
});
