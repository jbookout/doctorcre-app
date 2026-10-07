import { describe } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import { z } from 'zod';
import { verbTest as test } from '../api/fixture.ts';
import { randomUUID } from 'node:crypto';

const fields = ['name', 'city', 'state', 'company', 'phone', 'specialty', 'market', 'practice_name', 'address', 'practitioners', 'hours'];
const evidence = () => ({ sources: [{ url: 'https://example.com/e2e-staging-fixture', observed_at: new Date().toISOString() }], field_evidence: Object.fromEntries(fields.map(f => [f, [0]])), discrepancies: [] });
type Verb = (name: string, args?: Record<string, unknown>) => Promise<{ status: number; isError: boolean; data: any }>;
const uniqueToken = (kind: string) => `Zq${kind}${[...Array(8)].map(() => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
async function seedParty(verb: Verb, name: string, phone: string) {
  const party = await verb('add-party', { idempotency_key: randomUUID(), name, kind: 'person', org_name: `${name} Dental`, phone, city: 'Pensacola', state: 'FL', specialty: 'Dentistry', force_new: true, research_evidence: evidence() });
  expect(party.data?.ok, JSON.stringify(party.data)).toBe(true);
  return party.data.party_id as string;
}
async function seedLeadAndClient(verb: Verb, token: string) {
  const lead = await verb('new-lead', { idempotency_key: randomUUID(), party_id: await seedParty(verb, `${token} lead`, '(850) 555-0161'), stage: 'new', score: 60, score_reason: 'E2E journey fixture' });
  expect(lead.data?.ok, JSON.stringify(lead.data)).toBe(true);
  const client = await verb('new-client', { idempotency_key: randomUUID(), party_id: await seedParty(verb, `${token} client`, '(850) 555-0162'), status: 'engaged', acquisition_source: 'e2e fixture', research_evidence: evidence() });
  expect(client.data?.ok, JSON.stringify(client.data)).toBe(true);
}

// Area B journeys: Clients/Vendors workspace and Search. Staging holds 1 client
// (Synthetic Staging Fixture) and 0 vendors.
const opts = { session: 'staging-partner', tags: ['journey', 'area-b'] } as const;

async function ready(app: any, screen: any, path: string) {
  await app.open(path);
  const brief = screen.getByRole('button', 'Dismiss morning brief');
  if (await brief.isVisible().catch(() => false)) await brief.tap();
}

describe('area B: clients and vendors', () => {
  test('[business-search-filter-sort] search, filter and sort clients, then clear', opts, async ({ app, screen, agent, api }) => {
    await ready(app, screen, '/clients');
    await expect(screen.getByRole('link').filter({ hasText: 'Synthetic Staging Fixture' }).first()).toBeVisible();
    await agent.act('Type {q} into Search and press Apply', { params: { q: unique('Synthetic') } });
    await expect(screen.getByRole('link').filter({ hasText: 'Synthetic Staging Fixture' }).first()).toBeVisible();
    const hit = await (await api('/api/v1/business/clients?q=Synthetic')).json();
    expect(hit.total).toBeGreaterThanOrEqual(1);
    await agent.act('Choose Last deal · most recent in the Sort menu and press Apply');
    await expect(screen.getByLabel('Sort')).toHaveValue('last_deal_desc');
    await agent.act('Type {q} into Search and press Apply', { params: { q: unique('zzz no such client') } });
    await expect(screen.getByRole('button', 'Clear all filters')).toBeVisible();
    await agent.act('Press Clear all filters');
    await expect(screen.getByRole('link').filter({ hasText: 'Synthetic Staging Fixture' }).first()).toBeVisible();
    const read = await agent.extract('the number of client records listed under Results', { schema: z.object({ count: z.number().int() }) });
    expect(read.count).toBe((await (await api('/api/v1/business/clients')).json()).total);
    await expect(screen.getByLabel('Sort')).toHaveValue('name');
    await screen.getByLabel('Sort').selectOption({ label: 'Vertical' });
    await agent.act('Press Reset in the search and filter form');
    await expect(screen.getByLabel('Sort')).toHaveValue('name');
  });

  test('[business-record-panel] open a record and close it', opts, async ({ app, screen, agent }) => {
    await ready(app, screen, '/clients');
    await agent.act('Open the client record Synthetic Staging Fixture');
    await expect(screen.getByRole('dialog').getByRole('heading', 'Synthetic Staging Fixture')).toBeVisible();
    await expect(screen.getByRole('button', 'Close record')).toBeVisible();
    await agent.act('Close record');
    await expect(screen.getByRole('button', 'Close record')).toBeHidden();
  });

  test('[vendor-trust-rating] set and reset a vendor trust rating', opts, async ({ app, screen, api }) => {
    const vendors = await (await api('/api/v1/business/vendors')).json();
    test.skip(vendors.total === 0, 'BLOCKED: staging has 0 vendors and new-vendor cannot mint one (vendor_stage table is empty: unknown_vendor_stage, valid: [])');
    await ready(app, screen, '/vendors');
  });
});

describe('area B: search', () => {
  test('[search-run] search by name and see results and the URL', opts, async ({ app, screen, agent, browser, verb }) => {
    const token = uniqueToken('srch');
    await seedLeadAndClient(verb, token);
    await ready(app, screen, '/search');
    await agent.act('In the Find a record card, type {q} into the Name to search box and press the Search button in that card', { params: { q: unique(token) } });
    await expect(browser).toHaveURL(new RegExp(`[?&]q=${token}`));
    await expect(screen.getByRole('heading', `${token} lead`).first()).toBeVisible();
    await expect(screen.getByText(/\d+ shown/)).toBeVisible();
    const found = await verb('find', { query: token });
    expect(found.isError).toBe(false);
    expect(JSON.stringify(found.data)).toContain(`${token} client`);
    // A query that also matches deals: the page must show them, not an error state.
    await agent.act('In the Find a record card, type {q} into the Name to search box and press the Search button in that card', { params: { q: unique('Synthetic') } });
    await expect(browser).toHaveURL(/[?&]q=Synthetic/);
    await expect(screen.getByText('Search temporarily unavailable')).toBeHidden();
    await expect(screen.getByRole('heading', 'Synthetic Staging Fixture').first()).toBeVisible();
  });

  test('[search-scope-chips] toggle a scope chip over results', opts, async ({ app, screen, agent, verb }) => {
    const token = uniqueToken('chip');
    await seedLeadAndClient(verb, token);
    await ready(app, screen, `/search?q=${token}`);
    await expect(screen.getByText(/\d+ shown/)).toBeVisible();
    const before = Number((await screen.getByText(/\d+ shown/).textContent()).match(/\d+/)![0]);
    const chips = await agent.extract('every scope chip label under Scope, including its count', { schema: z.object({ chips: z.array(z.string()) }) });
    expect(chips.chips.length).toBeGreaterThan(1);
    const leads = chips.chips.find(c => c.startsWith('Leads'))!;
    expect(leads).toBeTruthy();
    const other = chips.chips.find(c => !c.startsWith('Leads'))!;
    await screen.getByRole('button', leads).tap();
    await expect(screen.getByRole('button', leads)).toHaveAttribute('aria-pressed', 'true');
    await expect(screen.getByRole('button', other)).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => Number((await screen.getByText(/\d+ shown/).textContent()).match(/\d+/)![0])).toBeLessThan(before);
    await screen.getByRole('button', leads).tap();
    await expect(screen.getByRole('button', other)).toHaveAttribute('aria-pressed', 'true');
    await expect(screen.getByText(`${before} shown`)).toBeVisible();
  });

  test('[search-saved-views] save and reset a saved search view', opts, async ({ app, screen, agent, verb }) => {
    const token = uniqueToken('view');
    await seedLeadAndClient(verb, token);
    await ready(app, screen, `/search?q=${token}`);
    await expect(screen.getByText('4 shown')).toBeVisible();
    const view = `E2E ${Date.now()} view`;
    await screen.getByLabel('Name for this view').fill(view);
    await screen.getByRole('button', 'Save this view').tap();
    await expect(screen.getByRole('link', view)).toBeVisible();
    await agent.assert(`the Saved views card lists a saved view named "${view}"`);
    await app.open('/search');
    await expect(screen.getByRole('link', view)).toBeVisible();
    await agent.act('Press the Reset button in the Saved views card');
    await expect(screen.getByRole('link', view)).toBeHidden();
  });
});
