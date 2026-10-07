import { verbTest as test } from '../api/fixture.ts';
import { expect } from 'e2e';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

// Area A journeys: Home and Charts. One test per feature id, driven by agent.act with a
// locator pin after every act, and an independent record-layer read where the outcome persists.
const key = () => randomUUID();

/** Open a page and dismiss the Morning brief dialog, which opens a few seconds after load and blocks clicks. */
async function ready(app: any, screen: any, path: string) {
  await app.open(path);
  const dismiss = screen.getByRole('button', 'Dismiss morning brief');
  await dismiss.waitFor({ timeout: 9_000 }).catch(() => {});
  if (await dismiss.isVisible()) await dismiss.tap();
}

async function seedDeal(verb: any, name: string, owner: string | null = 'joe') {
  const made = await verb('new-deal', { idempotency_key: key(), client: 'C-001', name, deal_type: 'startup', phase: 'pending' });
  expect(made.isError).toBe(false);
  if (owner) {
    const set = await verb('patch-deal-field', { idempotency_key: key(), deal: name, field: 'owner', value: owner, base_event_id: null });
    expect(set.isError, JSON.stringify(set.data)).toBe(false);
  }
  return made.data.deal_id as string;
}

const Counts = z.object({ active: z.number().int(), national: z.number().int() });
const tags = { session: 'staging-partner', tags: ['journey', 'area-a'] } as const;

test('[home-scope-switch] switch Home between Team View and Just Me', tags, async ({ app, screen, agent }) => {
  await ready(app, screen, '/');
  await expect(screen.getByRole('button', { name: 'Team View', pressed: true })).toBeVisible();
  const team = await agent.extract('the Active Deals count and the National Account Deals count in the Deal flags header', { schema: Counts });

  await agent.act('switch Home to Just Me');
  await expect(screen.getByRole('button', { name: 'Just Me', pressed: true })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Team View', pressed: false })).toBeVisible();
  const mine = await agent.extract('the Active Deals count and the National Account Deals count in the Deal flags header', { schema: Counts });
  expect(mine.active).toBeLessThanOrEqual(team.active);

  await agent.act('switch Home back to Team View');
  await expect(screen.getByRole('button', { name: 'Team View', pressed: true })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Just Me', pressed: false })).toBeVisible();
});

test('[home-refresh] refresh Home and see the updated time', tags, async ({ app, screen, agent }) => {
  await ready(app, screen, '/');
  await agent.act('press Refresh Home');
  await expect(screen.getByRole('button', 'Refresh Home')).toHaveAttribute('aria-busy', 'false');
  await agent.waitFor('Home shows an Updated time with an hour and minute next to the refresh button and no loading message');
  await expect(screen.getByRole('main').first().getByText(/^Updated \d{1,2}:\d{2}\s?[AP]M$/).first()).toBeVisible();
});

test('[home-deal-flags] deal flags header counts match the deals board', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} flagged home deal`;
  await seedDeal(verb, name);
  expect((await verb('patch-deal-field', { idempotency_key: key(), deal: name, field: 'attention', value: true, base_event_id: null })).isError).toBe(false);
  await ready(app, screen, '/');
  await expect(screen.getByRole('main').first().getByText(name)).toBeVisible();
  const shown = await agent.extract('the Active Deals count and the National Account Deals count in the Deal flags header', { schema: Counts });
  const board = (await verb('deal-room-board', {})).data.deals as any[];
  const open = board.filter(d => d.phase !== 'closed' && d.operating_state !== 'parked');
  expect(shown.active, 'Active Deals on Home vs open deals on the board').toBe(open.length);
  expect(shown.national).toBe(open.filter(d => d.workspace_kind === 'national_account' || d.account_client_id).length);
  await agent.assert('the Deal flags panel lists the flagged deal and does not show a "No deal flags" message');
  await expect(screen.getByRole('main').first().getByText('No deal flags')).toBeHidden();
});

test('[home-invoice-attention] invoice attention panel lists overdue invoices and links to Invoices', tags, async () => {
  test.skip(true, 'BLOCKED: needs an invoiced, overdue CARR commission row (v_invoice_tracker commission_id with due_on in the past); no record-layer verb creates a commission (record-deal-invoice only marks the deal invoiced, record-commission-receipt needs an existing commission)');
});

test('[home-calendar-tasks] Calendar & tasks panel opens the calendar', tags, async ({ app, screen, agent, browser, verb }) => {
  const name = `E2E ${Date.now()} home calendar deal`;
  await seedDeal(verb, name);
  const due = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const added = await verb('add-critical-date', { idempotency_key: key(), deal: name, kind: 'E2E option window', due_on: due, source: 'E2E journey seed' });
  expect(added.isError).toBe(false);
  await ready(app, screen, '/');
  await expect(screen.getByRole('heading', 'Calendar & tasks')).toBeVisible();
  await expect(screen.getByRole('main').first().getByText('E2E option window').first()).toBeVisible();
  await agent.act('open the calendar from the Calendar & tasks panel with Open Calendar');
  await expect(browser).toHaveURL(/\/calendar/);
  await expect(screen.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
});

test('[home-control-room] control room panel shows attention state and opens Control Room', tags, async ({ app, screen, agent, browser }) => {
  await ready(app, screen, '/');
  await expect(screen.getByRole('heading', 'Control room').first()).toBeVisible();
  await expect(screen.getByRole('main').first().getByText(/^(Needs attention|No issues)$/).first()).toBeVisible();
  await agent.act('open the Control room panel');
  await expect(browser).toHaveURL(/\/control-room/);
});

test('[home-new-leads] new leads widget opens a lead detail dialog', tags, async ({ app, screen, agent, verb }) => {
  const board = (await verb('lead-board', {})).data.leads as any[];
  const fresh = board.filter(l => l.score !== null && Date.now() - Date.parse(l.created_at) < 6 * 86_400_000);
  test.skip(fresh.length === 0, 'BLOCKED: needs a lead with a numeric score created in the last 7 days (none on staging; new-lead needs add-party research evidence)');
  const top = [...fresh].sort((a, b) => Number(b.score) - Number(a.score))[0];
  await ready(app, screen, '/');
  await expect(screen.getByRole('heading', 'New leads')).toBeVisible();
  await agent.act('open the top new lead named {name} in the New leads widget', { params: { name: top.name } });
  await expect(screen.getByRole('button', 'Close details')).toBeVisible();
  await expect(screen.getByRole('heading', top.name)).toBeVisible();
  await agent.act('close the lead details');
  await expect(screen.getByRole('button', 'Close details')).toBeHidden();
});

test('[home-past-clients] past clients widget reads lease data', tags, async ({ app, screen, agent }) => {
  await ready(app, screen, '/');
  await expect(screen.getByRole('heading', 'Past clients')).toBeVisible();
  await agent.act('press Refresh past-client touches');
  await expect(screen.getByRole('button', 'Refresh past-client touches')).toBeEnabled();
  await agent.assert('the Past clients widget shows either a list of past-client touches due or the message "No touches due", plus an Updated time');
  await expect(screen.getByRole('main').first().getByText(/No touches due|touch/i).first()).toBeVisible();
});

test('[home-suggested-introductions] suggested introduction opens the relationship dialog', tags, async () => {
  test.skip(true, 'BLOCKED: needs an offered introduction edge in the relationship network (GET /api/v1/business/relationships suggestions is empty); creating one needs two verified parties via add-party research_evidence plus link-parties kind can_introduce');
});

test('[charts-pick-slice] pick a chart slice, see N of M records, clear it, open it in the Deals board', tags, async ({ app, screen, agent, browser, verb }) => {
  await seedDeal(verb, `E2E ${Date.now()} chart deal`);
  await ready(app, screen, '/?view=charts');
  await expect(screen.getByRole('heading', 'By phase')).toBeVisible();
  await agent.act('pick the Prospective Client slice of the By phase chart');
  await expect(screen.getByRole('button', { name: 'Prospective Client', pressed: true })).toBeVisible();
  await expect(screen.getByRole('button', 'Clear this slice')).toBeVisible();
  await expect(screen.getByText(/^\d+ of \d+ records/).first()).toBeVisible();

  await agent.act('clear this slice');
  await expect(screen.getByRole('button', 'Clear this slice')).toBeHidden();
  await expect(screen.getByRole('button', { name: 'Prospective Client', pressed: false })).toBeVisible();

  await agent.act('pick the Prospective Client slice of the By phase chart again');
  await expect(screen.getByRole('link', 'Open in Deals board')).toBeVisible();
  await agent.act('press Open in Deals board');
  await expect(browser).toHaveURL(/\/deals/);
});

test('[charts-tabs] Overview and Charts tabs switch views', tags, async ({ app, screen, agent, browser }) => {
  await ready(app, screen, '/?view=charts');
  await expect(screen.getByRole('link', { name: 'Charts' }).first()).toHaveAttribute('aria-current', 'page');
  await expect(screen.getByRole('heading', 'By phase')).toBeVisible();
  await agent.act('open the Overview tab');
  await expect(browser).toHaveURL(/^[^?#]*\/$/);
  await expect(screen.getByRole('heading', 'Control room').first()).toBeVisible();
  // The tabs are one switch: from Overview the Charts tab must be there to go back.
  await expect(screen.getByRole('link', { name: 'Charts', exact: true })).toBeVisible();
  await agent.act('open the Charts tab');
  await expect(browser).toHaveURL(/view=charts/);
  await expect(screen.getByRole('heading', 'By phase')).toBeVisible();
});
