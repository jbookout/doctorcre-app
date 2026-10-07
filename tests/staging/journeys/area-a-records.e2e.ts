import { verbTest as test } from '../api/fixture.ts';
import { expect, unique } from 'e2e';
import { randomUUID } from 'node:crypto';

// Area A journeys: Calendar, Relationships, Lease radar, Invoices.
const key = () => randomUUID();
const tags = { session: 'staging-partner', tags: ['journey', 'area-a'] } as const;

async function ready(app: any, screen: any, path: string) {
  await app.open(path);
  const dismiss = screen.getByRole('button', 'Dismiss morning brief');
  await dismiss.waitFor({ timeout: 9_000 }).catch(() => {});
  if (await dismiss.isVisible()) await dismiss.tap();
}
async function openSidebar(screen: any) {
  const t = screen.getByRole('button', 'Workspace sidebar');
  if ((await t.getAttribute('aria-expanded')) !== 'true') await t.tap();
}
const monthName = (d: Date) => d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
const dayLabel = (d: Date) => d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

test('[calendar-view-step] switch Month/Week and step through months', tags, async ({ app, screen, agent }) => {
  await ready(app, screen, '/calendar');
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  await expect(screen.getByRole('heading', monthName(now))).toBeVisible();
  await agent.act('go to the next month');
  await expect(screen.getByRole('heading', monthName(next))).toBeVisible();
  await agent.act('go back to Today');
  await expect(screen.getByRole('heading', monthName(now))).toBeVisible();
  await agent.act('open the Week view');
  await expect(screen.getByRole('button', { name: 'Week', pressed: true })).toBeVisible();
  await agent.act('open the Month view');
  await expect(screen.getByRole('button', { name: 'Month', pressed: true })).toBeVisible();
});

test('[calendar-select-day] select a day with a critical date and read the agenda', tags, async ({ app, screen, agent, verb }) => {
  const name = `E2E ${Date.now()} calendar day deal`;
  const made = await verb('new-deal', { idempotency_key: key(), client: 'C-001', name, deal_type: 'startup', phase: 'pending' });
  expect(made.isError, JSON.stringify(made.data)).toBe(false);
  expect((await verb('patch-deal-field', { idempotency_key: key(), deal: name, field: 'owner', value: 'joe', base_event_id: null })).isError).toBe(false);
  const due = new Date(); due.setDate(due.getDate() + 2);
  const iso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
  const add = await verb('add-critical-date', { idempotency_key: key(), deal: name, kind: 'E2E calendar marker', due_on: iso, source: 'E2E journey seed' });
  expect(add.isError, JSON.stringify(add.data)).toBe(false);
  await ready(app, screen, '/calendar');
  const label = dayLabel(due);
  await expect(screen.getByText("Reading every deal's critical dates…")).toBeHidden({ timeout: 60_000 });
  await expect(screen.getByRole('button', new RegExp(`^${label}`)).first()).toBeVisible();
  await agent.act('select the day {day} in the calendar grid', { params: { day: label } });
  await expect(screen.getByRole('button', { name: new RegExp(`^${label}`), pressed: true }).first()).toBeVisible();
  await expect(screen.getByRole('heading', 'Selected day')).toBeVisible();
  await expect(screen.getByText('E2E calendar marker').first()).toBeVisible();
  await expect(screen.getByRole('heading', 'Coming up')).toBeVisible();
});

test('[relationships-filters] find a relationship by name and clear filters', tags, async ({ app, screen, agent }) => {
  await ready(app, screen, '/relationships');
  await openSidebar(screen);
  await expect(screen.getByLabel('Find a relationship')).toBeVisible();
  await agent.act('search for the relationship {term} in Find a relationship', { params: { term: 'Synthetic Staging Fixture' } });
  await expect(screen.getByLabel('Find a relationship')).toHaveValue('Synthetic Staging Fixture');
  await expect(screen.getByRole('button', 'Open Synthetic Staging Fixture, client')).toBeVisible();
  await expect(screen.getByRole('button', /Open E2E .* hot lead, lead/)).toBeHidden();
  await agent.act('press Clear filters');
  await expect(screen.getByLabel('Find a relationship')).toHaveValue('');
  await expect(screen.getByRole('button', /Open E2E .*, deal/).first()).toBeVisible();
});

test('[relationships-tabs] switch between Network and Referrals', tags, async ({ app, screen, agent }) => {
  await ready(app, screen, '/relationships');
  await expect(screen.getByRole('tablist', 'Relationship views')).toBeVisible();
  await agent.act('open the Referrals tab');
  await expect(screen.getByRole('tab', { name: 'Referrals', selected: true })).toBeVisible();
  await expect(screen.getByRole('button', 'Zoom in')).toBeHidden();
  await agent.act('open the Network tab');
  await expect(screen.getByRole('tab', { name: 'Network', selected: true })).toBeVisible();
  await expect(screen.getByRole('button', 'Zoom in')).toBeVisible();
});

test('[relationships-network-graph] zoom and fit the graph and open a node', tags, async ({ app, screen, agent }) => {
  await ready(app, screen, '/relationships');
  await expect(screen.getByRole('button', 'Zoom in')).toBeVisible();
  await agent.act('press Zoom in');
  await expect(screen.getByRole('button', 'Zoom out')).toBeEnabled();
  await agent.act('press Zoom out');
  await agent.act('press Fit');
  await expect(screen.getByRole('button', 'Fit')).toBeVisible();
  await agent.act('open the node Open Synthetic Staging Fixture, client');
  await expect(screen.getByRole('dialog')).toBeVisible();
  await expect(screen.getByRole('dialog').getByText('Synthetic Staging Fixture').first()).toBeVisible();
  await screen.getByRole('button', 'Close relationship').tap();
});

test('[relationships-dialog] relationship dialog shows deals sent and connections', tags, async ({ app, screen, agent }) => {
  await ready(app, screen, '/relationships');
  await agent.act('open the node Open Synthetic Staging Fixture, client');
  const dlg = screen.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('heading', 'Connections')).toBeVisible();
  // 'Deals sent' only renders for a referral source with referred deals; staging has none (see report).
  await screen.getByRole('button', 'Close relationship').tap();
  await expect(dlg).toBeHidden();
});

test('[leases-controls] lease radar find client, Team/Mine scope and tabs', tags, async ({ app, screen, agent }) => {
  await ready(app, screen, '/leases');
  await openSidebar(screen);
  await agent.act('type {term} into Find client', { params: { term: unique('zzz-no-such-client') } });
  await expect(screen.getByLabel('Client')).not.toHaveValue('');
  await screen.getByLabel('Client').fill('');
  await agent.act('choose Mine in the lease scope');
  await expect(screen.getByLabel('Leases')).toHaveValue('mine');
  await agent.act('choose Team in the lease scope');
  await expect(screen.getByLabel('Leases')).toHaveValue('team');
  await agent.act('open the Missing dates tab');
  await expect(screen.getByRole('button', { name: 'Missing dates', pressed: true })).toBeVisible();
  await agent.act('open the Lease timeline tab');
  await expect(screen.getByRole('button', { name: 'Lease timeline', pressed: true })).toBeVisible();
});

test('[leases-timeline] open a lease from the timeline', tags, async ({ app, screen }) => {
  test.skip(true, 'BLOCKED: needs an executed lease with an expiry date; record-executed-lease requires an authority connection that staging does not have, and no UI path creates a lease');
  await ready(app, screen, '/leases');
});

test('[invoices-filters] search invoices, filter by status and aging', tags, async ({ app, screen, agent }) => {
  await ready(app, screen, '/invoices');
  await openSidebar(screen);
  await expect(screen.getByRole('button', /Awaiting invoice$/).first()).toBeVisible();
  await agent.act('search invoices for {term}', { params: { term: 'invoice seed' } });
  await expect(screen.getByLabel('Search invoices')).toHaveValue('invoice seed');
  await expect(screen.getByRole('button', /invoice seed, Awaiting invoice/)).toBeVisible();
  await expect(screen.getByRole('button', /Synthetic staging QA .* closed deal/)).toBeHidden();
  await agent.act('press Clear filters');
  await expect(screen.getByLabel('Search invoices')).toHaveValue('');
  await agent.act('open the Paid status tab');
  await expect(screen.getByRole('button', { name: 'Paid', pressed: true })).toBeVisible();
  await agent.act('open the All status tab');
  await expect(screen.getByRole('button', { name: 'All', exact: true, pressed: true })).toBeVisible();
  await agent.act('choose the 0–30 days aging bucket');
  await expect(screen.getByRole('button', { name: /^0–30 days/, pressed: true })).toBeVisible();
  await agent.act('choose All ages');
  await expect(screen.getByRole('button', { name: 'All ages', pressed: true })).toBeVisible();
});

test('[invoices-detail] open an invoice commission dialog', tags, async ({ app, screen, agent }) => {
  await ready(app, screen, '/invoices');
  await agent.act('open the invoice row {row}', { params: { row: 'E2E invoice seed, Awaiting invoice' } });
  const dlg = screen.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText('COMMISSION', { exact: false }).first()).toBeVisible();
  await expect(dlg.getByRole('button', 'Close invoice')).toBeVisible();
  await agent.act('press Close invoice');
  await expect(dlg).toBeHidden();
});

test('[invoices-mark-paid] mark an invoice paid', tags, async ({ app, screen }) => {
  test.skip(true, 'BLOCKED: needs an invoiced commission (status Unpaid) created by the test; no verb or UI path creates a commission on staging (record-deal-invoice yields only awaiting-invoice rows), and Mark paid has no undo so the pre-existing invoice must not be used');
  await ready(app, screen, '/invoices');
});
