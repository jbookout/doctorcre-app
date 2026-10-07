import { verbTest as test } from '../api/fixture.ts';
import { expect, unique } from 'e2e';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

// Area A journeys: the Deals board (/deals), the Deals list and National Accounts (/deals?view=national).
// Every mutating test creates its own "E2E <ts> ..." records through the verb fixture so the two
// pre-existing deals stay untouched, except deals-undo-phase which needs a pre-existing automatic move.
const key = () => randomUUID();
const tags = { session: 'staging-partner', tags: ['journey', 'area-a'] } as const;
const EVIDENCE = {
  sources: [{ url: 'https://example.test/e2e', observed_at: new Date().toISOString() }],
  field_evidence: Object.fromEntries(['name', 'company', 'phone', 'specialty', 'market'].map(k => [k, [0]])),
  discrepancies: [],
};

async function ready(app: any, screen: any, path: string) {
  await app.open(path);
  const dismiss = screen.getByRole('button', 'Dismiss morning brief');
  await dismiss.waitFor({ timeout: 9_000 }).catch(() => {});
  if (await dismiss.isVisible()) await dismiss.tap();
}
async function seedDeal(verb: any, name: string, opts: { owner?: string | null; phase?: string; attention?: boolean } = {}) {
  const made = await verb('new-deal', { idempotency_key: key(), client: 'C-001', name, deal_type: 'startup', phase: opts.phase ?? 'pending' });
  expect(made.isError, JSON.stringify(made.data)).toBe(false);
  const owner = opts.owner === undefined ? 'joe' : opts.owner;
  if (owner) expect((await verb('patch-deal-field', { idempotency_key: key(), deal: name, field: 'owner', value: owner, base_event_id: null })).isError).toBe(false);
  if (opts.attention) expect((await verb('patch-deal-field', { idempotency_key: key(), deal: name, field: 'attention', value: true, base_event_id: null })).isError).toBe(false);
  return made.data.deal_id as string;
}
async function seedAccount(verb: any, name: string, owner = 'joe') {
  const r = await verb('create-national-account', { idempotency_key: key(), name, owner, vertical: 'Dental', research_evidence: EVIDENCE });
  expect(r.isError, JSON.stringify(r.data)).toBe(false);
  return r.data.account_client_id as string;
}
const boardDeal = async (verb: any, name: string) => ((await verb('deal-room-board', {})).data.deals as any[]).find(d => d.name === name);
const card = (screen: any, name: string, phase?: string) => screen.getByRole('article', { name: new RegExp(`^${name}, ${phase ?? ''}`) });
const names = (name: string) => ({ name: unique(name) });
const narrow = async (screen: any, term: string) => { await screen.getByPlaceholder('Search work records…').fill(term); };
const listRow = (screen: any, name: string) => screen.getByRole('table').getByText(name, { exact: true });
/** The toolbar (filters, search, add) lives in the Workspace sidebar, closed by default on board pages. */
async function openSidebar(screen: any) {
  const toggle = screen.getByRole('button', 'Workspace sidebar');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
async function openList(app: any, screen: any) {
  await ready(app, screen, '/deals?view=national');
  await screen.getByRole('button', 'All Deals').tap();
  await openSidebar(screen);
  await expect(screen.getByRole('group', 'Filter work records')).toBeVisible();
}

// ----------------------------------------------------------------- board (/deals)

test('[deals-owner-view] owner chips All/Joe/Dell and Board/List/Parked views filter the board', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} owner view deal`;
  await seedDeal(verb, name, { owner: 'joe' });
  await ready(app, screen, '/deals');
  await expect(card(screen, name)).toBeVisible();

  await agent.act('show only Dell deals with the Dell owner chip');
  await expect(screen.getByRole('button', { name: 'Dell', pressed: true })).toBeVisible();
  await expect(card(screen, name)).toBeHidden();

  await agent.act('show only Joe deals with the Joe owner chip');
  await expect(screen.getByRole('button', { name: 'Joe', pressed: true })).toBeVisible();
  await expect(card(screen, name)).toBeVisible();

  await agent.act('switch to the List view');
  await expect(screen.getByRole('button', { name: 'List', pressed: true })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Board', pressed: false })).toBeVisible();

  await agent.act('open the Parked view');
  await expect(screen.getByRole('button', { name: 'Parked', pressed: true })).toBeVisible();
  await expect(card(screen, name)).toBeHidden();
});

test('[deals-move-phase] move a deal to Research with keyboard lift and drop and the Move dialog', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} move phase deal`;
  await seedDeal(verb, name);
  await ready(app, screen, '/deals');
  const c = card(screen, name, 'Prospective Client');
  await expect(c).toBeVisible();
  await c.focus();
  await c.press('Enter');
  await c.press('ArrowRight');
  await c.press('Enter');
  await expect(screen.getByRole('button', 'Move to Research')).toBeVisible();

  await agent.act('confirm the move by pressing Move to Research');
  await expect(card(screen, name, 'Research')).toBeVisible();
  await expect.poll(async () => (await boardDeal(verb, name)).phase, { message: 'persisted phase' }).toBe('research');
});

test('[deals-undo-phase] undo an automatic phase change', tags, async ({ app, screen, agent, verb }) => {
  const before = ((await verb('deal-room-board', {})).data.deals as any[]).find(d => d.phase_change?.automatic === true);
  test.skip(!before, 'BLOCKED: needs a deal whose latest phase change is automatic (phase_change.automatic); only the pre-existing closed fixture has one and no verb creates another');
  await ready(app, screen, '/deals');
  const undo = screen.getByRole('button', { name: new RegExp(`^Undo phase change on ${before.name}`) });
  await expect(undo).toBeVisible();
  await agent.act('press Undo phase change on the deal {name}', { params: { name: before.name } });
  await expect(card(screen, before.name, 'Prospective Client')).toBeVisible();
  await expect.poll(async () => (await boardDeal(verb, before.name)).phase).toBe(before.phase_change.prior_phase);
  // Restore the fixture to its closed phase by reverting the revert.
  const now = await boardDeal(verb, before.name);
  expect((await verb('revert-deal-field', { idempotency_key: key(), event_id: now.phase_change.event_id })).isError).toBe(false);
  await expect.poll(async () => (await boardDeal(verb, before.name)).phase).toBe(before.phase);
});

test('[deals-record-panel] open a deal record panel from its card and from ?deal=', tags, async ({ app, screen, agent, browser, verb }) => {
  const name = `E2E ${Date.now()} record panel deal`;
  const id = await seedDeal(verb, name);
  await ready(app, screen, '/deals');
  await card(screen, name).getByRole('button', name).tap();
  await expect(screen.getByRole('button', 'Close deal')).toBeVisible();
  await expect(screen.getByRole('dialog', name)).toBeVisible();
  await agent.act('close the deal panel');
  await expect(screen.getByRole('button', 'Close deal')).toBeHidden();

  await app.open(`/deals?deal=${id}`);
  await expect(screen.getByRole('dialog', name)).toBeVisible();
  await expect(screen.getByRole('button', 'Close deal')).toBeVisible();
  await expect(browser).toHaveURL(/deal=/);
});

test('[deals-park] park a deal with a reason and revive it', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} park deal`;
  const id = await seedDeal(verb, name);
  await ready(app, screen, `/deals?deal=${id}`);
  await expect(screen.getByRole('button', 'Close deal')).toBeVisible();
  await agent.act('open Park, fill the Park reason {reason}, and press Park deal', { params: { reason: unique(`E2E ${Date.now()} client paused`) } });
  await expect.poll(async () => (await boardDeal(verb, name)).operating_state, { timeout: 30_000 }).toBe('parked');
  await app.open(`/deals?deal=${id}`);
  await expect(screen.getByRole('button', 'Revive')).toBeVisible();

  await agent.act('press Revive');
  await expect.poll(async () => (await boardDeal(verb, name)).operating_state, { timeout: 30_000 }).toBe('active');
  await app.open(`/deals?deal=${id}`);
  await expect(screen.getByRole('button', 'Revive')).toBeHidden();
});

test('[deals-save-next-step] save a next step with a due date', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} next step deal`;
  const id = await seedDeal(verb, name);
  const step = `E2E ${Date.now()} send the lease draft`;
  await ready(app, screen, `/deals?deal=${id}`);
  await expect(screen.getByRole('button', 'Save next step')).toBeVisible();
  await agent.act('type the Next step {step} and the Due date {date}', { params: { step: unique(step), date: '2026-11-20' } });
  await expect(screen.getByLabel('Next step')).toHaveValue(step);
  await screen.getByRole('button', 'Save next step').tap();
  await expect.poll(async () => (await boardDeal(verb, name)).next_step, { timeout: 30_000 }).toContain(step);
  await expect.poll(async () => (await boardDeal(verb, name)).next_date).toBe('2026-11-20');
});

test('[deals-add-date] add a critical date to a deal', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} add date deal`;
  const id = await seedDeal(verb, name);
  await ready(app, screen, `/deals?deal=${id}`);
  await expect(screen.getByRole('button', 'LOI ＋ Add date')).toBeVisible();
  await agent.act('press Add date next to LOI');
  await expect(screen.getByRole('button', 'Save date')).toBeVisible();
  await agent.act('fill the date {date} and the lease clause or contract reference {ref} then press Save date', { params: { date: '2026-12-15', ref: unique(`E2E ${Date.now()} clause 4.2`) } });
  await expect(screen.getByRole('button', 'Save date')).toBeHidden();
  await expect.poll(async () => JSON.stringify((await verb('get-deal-room', { deal: name })).data)).toContain('2026-12-15');
});

test('[deals-outlook] deal outlook (Jev reading)', tags, async ({ app, screen, agent, browser, verb }) => {
  const name = `E2E ${Date.now()} outlook deal`;
  const id = await seedDeal(verb, name);
  await ready(app, screen, `/deals?deal=${id}`);
  await expect(screen.getByRole('button', 'Deal outlook')).toBeVisible();
  await agent.act('press Deal outlook');
  await expect(screen.getByRole('button', 'Deal outlook')).toBeEnabled({ timeout: 60_000 });
  await expect(browser.locator('#panelBody [data-jev-result]')).toHaveText(/\S/, { timeout: 30_000 });
  await agent.assert('under the Deal outlook button the page shows a reading about the deal or a stated message that the outlook is unavailable');
});

test('[deals-client-vendor-context] client and vendor context drawer in a deal', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} context deal`;
  const id = await seedDeal(verb, name);
  await ready(app, screen, `/deals?deal=${id}`);
  await expect(screen.getByRole('button', 'Client & vendor context')).toBeVisible();
  await agent.act('open Client & vendor context');
  await expect(screen.getByRole('heading', 'Client & vendor context').last()).toBeVisible();
  expect(((await verb('get-deal-room', { deal: name })).data as any).client_name).toBe('Synthetic Staging Fixture');
  await expect(screen.getByText('This deal is not linked to a client record.')).toBeHidden();
  await expect(screen.getByText('Synthetic Staging Fixture').first()).toBeVisible();
  await agent.act('close the Client & vendor context drawer');
  await expect(screen.getByRole('button', 'Close', { exact: true })).toBeHidden();
});

test('[deals-recent-changes] recent changes feed', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} recent changes deal`;
  await seedDeal(verb, name);
  await ready(app, screen, '/deals');
  await openSidebar(screen);
  await expect(screen.getByRole('button', { name: /^Recent changes \d+$/ })).toBeVisible();
  await agent.act('open Recent changes');
  await expect(screen.getByRole('complementary').getByText(name).first()).toBeVisible();
});

// ----------------------------------------------------------------- list and national accounts (/deals?view=national)

test('[deals-list-filter] filter work records (Active, Mine, Needs attention, Flagged ...)', tags, async ({ app, screen, agent, verb }) => {
  const flagged = `E2E ${Date.now()} flagged list deal`;
  const plain = `E2E ${Date.now()} plain list deal`;
  await seedDeal(verb, flagged, { attention: true });
  await seedDeal(verb, plain);
  await openList(app, screen);
  await expect(listRow(screen, flagged)).toBeVisible();
  await expect(listRow(screen, plain)).toBeVisible();
  await agent.act('show Flagged work records with the Flagged filter');
  await expect(listRow(screen, flagged)).toBeVisible();
  await expect(listRow(screen, plain)).toBeHidden();
  await agent.act('show Active work records with the Active filter');
  await expect(listRow(screen, plain)).toBeVisible();
});

test('[deals-list-search] search work records', tags, async ({ app, screen, agent, verb }) => {
  const stamp = Date.now();
  const hit = `E2E ${stamp} searchable zebra deal`;
  const miss = `E2E ${stamp} other list deal`;
  await seedDeal(verb, hit);
  await seedDeal(verb, miss);
  await openList(app, screen);
  await agent.act('search work records for {term}', { params: { term: unique(`${stamp} searchable zebra`) } });
  await expect(listRow(screen, hit)).toBeVisible();
  await expect(listRow(screen, miss)).toBeHidden();
});

test('[deals-add-work-record] add a work record (new deal)', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} added work record`;
  await openList(app, screen);
  await agent.act('press Add work record');
  await expect(screen.getByRole('button', 'Create work record')).toBeVisible();
  await agent.act('fill the existing client {client} and the record name {name}', { params: { client: 'C-001', name: unique(name) } });
  await expect(screen.getByLabel('Record name')).toHaveValue(name);
  await screen.getByRole('button', 'Create work record').tap();
  await expect(screen.getByRole('button', 'Create work record')).toBeHidden({ timeout: 30_000 });
  await narrow(screen, name);
  await expect(listRow(screen, name)).toBeVisible();
  await expect.poll(async () => (await boardDeal(verb, name))?.client_ref).toBe('C-001');
});

test('[deals-add-national-account] create a national account', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} Dental Brand`;
  await ready(app, screen, '/deals?view=national');
  await openSidebar(screen);
  await agent.act('press Add national account');
  await expect(screen.getByRole('button', 'Create account')).toBeVisible();
  await agent.act('fill the brand or organization {name}', { params: { name: unique(name) } });
  await expect(screen.getByLabel('Brand / organization')).toHaveValue(name);
  await screen.getByRole('button', 'Create account').tap();
  await expect(screen.getByRole('button', 'Create account')).toBeHidden({ timeout: 30_000 });
  await expect(screen.getByRole('button', { name: new RegExp(name) })).toBeVisible();
  const accounts = (await verb('deal-room-board', {})).data.accounts as any[];
  expect(accounts.map(a => a.account_name)).toContain(name);
});

test('[deals-add-market-deal] add a market deal to a national account', tags, async ({ app, screen, agent, verb }) => {
  const account = `E2E ${Date.now()} Market Brand`;
  await seedAccount(verb, account);
  await ready(app, screen, '/deals?view=national');
  await screen.getByRole('button', { name: new RegExp(account) }).tap();
  await openSidebar(screen);
  await expect(screen.getByRole('button', 'Add market deal')).toBeVisible();
  const deal = `E2E ${Date.now()} market deal`;
  await agent.act('press Add market deal');
  await expect(screen.getByRole('button', 'Create market deal')).toBeVisible();
  await agent.act('fill the franchisee {client}, the deal name {deal} and the market {market}', { params: { client: unique(`E2E ${Date.now()} Franchisee`), deal: unique(deal), market: 'Mobile' } });
  await expect(screen.getByLabel('Deal name')).toHaveValue(deal);
  await screen.getByRole('button', 'Create market deal').tap();
  await expect(screen.getByRole('button', 'Create market deal')).toBeHidden({ timeout: 30_000 });
  await expect(listRow(screen, deal)).toBeVisible();
  await expect.poll(async () => (await boardDeal(verb, deal))?.account_name).toBe(account);
});

test('[deals-flag-attention] flag and clear attention with undo', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} attention deal`;
  await seedDeal(verb, name);
  await openList(app, screen);
  await expect(screen.getByRole('button', `Flag for attention on ${name}`)).toBeVisible();
  await agent.act('flag the deal {name} for attention', { params: { name: unique(name) } });
  await expect(screen.getByRole('button', `Clear attention flag on ${name}`)).toBeVisible();
  await expect.poll(async () => (await boardDeal(verb, name)).attention).toBe(true);

  await agent.act('press Undo in the toast message');
  await expect(screen.getByRole('button', `Flag for attention on ${name}`)).toBeVisible();
  await expect.poll(async () => (await boardDeal(verb, name)).attention).toBe(false);
});

test('[deals-row-phase-owner] change phase and owner from a row select', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} row select deal`;
  await seedDeal(verb, name, { owner: 'joe' });
  await openList(app, screen);
  await narrow(screen, name);
  await expect(screen.getByRole('combobox', `Phase for ${name}`)).toBeVisible();
  await agent.act('set the Phase of the only listed work record to Research');
  await expect.poll(async () => (await boardDeal(verb, name)).phase, { timeout: 30_000 }).toBe('research');
  await agent.act('set the Owner of the only listed work record to Dell');
  await expect.poll(async () => (await boardDeal(verb, name)).owner, { timeout: 30_000 }).toBe('dell');
});

test('[deals-park-restore] park a work record and restore it', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} list park deal`;
  await seedDeal(verb, name);
  await openList(app, screen);
  await narrow(screen, name);
  await agent.act('press Park on the only listed work record');
  await expect(screen.getByRole('button', 'Park record')).toBeVisible();
  await screen.getByRole('button', 'Park record').tap();
  await expect.poll(async () => (await boardDeal(verb, name)).operating_state, { timeout: 30_000 }).toBe('parked');
  await expect(listRow(screen, name)).toBeHidden();

  await agent.act('show Parked work records with the Parked filter');
  await expect(listRow(screen, name)).toBeVisible();
  await agent.act('press Restore on the only listed work record');
  await expect.poll(async () => (await boardDeal(verb, name)).operating_state, { timeout: 30_000 }).toBe('active');
});

test('[deals-next-step] set a next step from the list', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} list step deal`;
  await seedDeal(verb, name);
  const step = `E2E ${Date.now()} call the landlord`;
  await openList(app, screen);
  await narrow(screen, name);
  await agent.act('open the next step editor of the only listed work record and type the next step {step}', { params: { step: unique(step) } });
  await expect(screen.getByRole('button', 'Set next step')).toBeVisible();
  await screen.getByRole('button', 'Set next step').tap();
  await expect.poll(async () => (await boardDeal(verb, name)).next_step, { timeout: 30_000 }).toContain(step);
});

test('[deals-review-agenda] run a deal review agenda', tags, async ({ app, screen, agent, verb }) => {
  await seedDeal(verb, `E2E ${Date.now()} agenda deal`);
  await openList(app, screen);
  await agent.act('press Review deals');
  await expect(screen.getByRole('button', 'Reviewed — next')).toBeVisible({ timeout: 30_000 });
  const progress = await agent.extract('the review agenda progress text like "1 of 5" as the current position and the total', { schema: z.object({ position: z.number().int(), total: z.number().int() }) });
  expect(progress.total).toBeGreaterThan(1);
  await screen.getByRole('button', 'Reviewed — next').tap();
  await expect(screen.getByText(`2 of ${progress.total}`)).toBeVisible();
  await agent.act('press Finish agenda');
  await expect(screen.getByRole('button', 'Reviewed — next')).toBeHidden({ timeout: 30_000 });
  await agent.assert('a message says the agenda finished and how many records were reviewed');
});

test('[deals-change-account-owner] change a national account owner', tags, async ({ app, screen, agent, verb }) => {
  const account = `E2E ${Date.now()} Owner Brand`;
  const id = await seedAccount(verb, account, 'joe');
  await ready(app, screen, '/deals?view=national');
  await screen.getByRole('button', { name: new RegExp(account) }).tap();
  await openSidebar(screen);
  await expect(screen.getByRole('button', 'Change owner')).toBeVisible();
  await agent.act('press Change owner, choose Dell as the accountable partner and press Save owner');
  await expect(screen.getByRole('button', 'Save owner')).toBeHidden();
  await expect.poll(async () => ((await verb('deal-room-board', {})).data.accounts as any[]).find(a => a.account_client_id === id)?.account_owner).toBe('dell');
});

test('[deals-capture-confirm] confirm or skip call capture suggestions', tags, async ({ app, screen, agent, verb }) => {
  const queue = (await verb('capture-queue', {})).data.candidates as any[];
  test.skip(queue.length === 0, 'BLOCKED: needs a pending call-capture candidate in capture-queue (empty on staging; candidates come only from a recorded Call Mode session, which staging cannot run)');
  await openList(app, screen);
  await expect(screen.getByRole('region', 'Call capture suggestions')).toBeVisible();
  await agent.act('skip the first call capture suggestion');
});
