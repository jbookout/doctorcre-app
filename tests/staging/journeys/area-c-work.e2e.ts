import { describe } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import { z } from 'zod';
import { verbTest as test } from '../api/fixture.ts';
import { dismissMorningBrief } from '../support/brief.ts';

// Area C2 journeys: All Work, Work Requests and the Design Lab. Every page here
// reads asynchronously, so each test waits for its loading state to clear
// before asserting. Every act is pinned by a locator expect or agent.assert so
// the replay cache records it (docs/cache.mdx).

const AREAS = ['Work requests', 'Portfolio nodes', 'Open loops', 'Work shapes', 'Slice plans', 'Governance items'];

describe('area C2: All Work', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  test('[allwork-kind-filter] work-type chips and the status filter narrow the records and agree with the census', async ({ app, agent, screen, api }) => {
    await app.open('/all-work');
    await dismissMorningBrief(screen);
    await expect(screen.getByText('Census complete')).toBeVisible({ timeout: 30_000 });
    const census: any = await (await api('/api/v1/work-inventory?limit=100')).json();
    const counted = (census.coverage as any[]).reduce((sum, row) => sum + Number(row.count_total ?? 0), 0);
    expect(counted).toBeGreaterThan(0);
    // The three places the page states a count must agree with the API.
    await expect(screen.getByText(`${counted} records counted across all areas`, { exact: false })).toBeVisible();
    await expect(screen.getByText(`${counted} records shown.`, { exact: false })).toBeVisible();
    const group = screen.getByRole('group', { name: 'Work types' });
    for (const name of AREAS) await expect(group.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    await group.getByRole('button', { name: 'Portfolio nodes' }).click();
    await expect(group.getByRole('button', { name: 'Portfolio nodes' })).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    await expect(screen.getByText(`${counted} records shown.`, { exact: false })).toBeVisible();
    await group.getByRole('button', { name: 'Work requests' }).click();
    await expect(group.getByRole('button', { name: 'Work requests' })).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    await expect(screen.getByText('0 records shown.', { exact: false })).toBeVisible();
    await group.getByRole('button', { name: 'All areas' }).click();
    await expect(group.getByRole('button', { name: 'Work requests' })).toHaveAttribute('aria-pressed', 'true');
    await expect(screen.getByText(`${counted} records shown.`, { exact: false })).toBeVisible();
    // The status filter keeps only records whose status contains the text.
    await agent.act('Type captured into Status contains');
    await expect(screen.getByLabel('Status contains')).toHaveValue('captured');
    await expect(screen.getByText(/^1 records? shown\./)).toBeVisible();
    const shown = await agent.extract('The number of records the page says it shows', { schema: z.object({ shown: z.number().int() }) });
    expect(shown.shown).toBe(1);
    await screen.getByLabel('Status contains').fill('');
    await expect(screen.getByText(`${counted} records shown.`, { exact: false })).toBeVisible();
  });

  test('[allwork-records] records list every work request, paging is honest, and Open reaches that record', async ({ app, agent, browser, screen, api }) => {
    await app.open('/all-work');
    await dismissMorningBrief(screen);
    await expect(screen.getByText('Census complete')).toBeVisible({ timeout: 30_000 });
    const census: any = await (await api('/api/v1/work-inventory?limit=100')).json();
    const items = census.items as any[];
    await expect(screen.getByRole('heading', { name: 'Synthetic staging MCP catalog route proof', level: 3 }).first()).toBeVisible();
    await expect(screen.getByText('WR-000144').first()).toBeVisible();
    // Paging: with no further cursor the page must not offer Load more.
    if (census.next_cursor == null) await expect(screen.getByRole('button', { name: 'Load more' })).toBeHidden();
    else await expect(screen.getByRole('button', { name: 'Load more' })).toBeVisible();
    expect(items.length).toBeGreaterThan(0);
    // Open on the record row goes to that record, not to a generic list.
    const row = screen.getByRole('listitem').filter({ hasText: 'WR-000144' }).first();
    await row.getByRole('link', { name: 'Open', exact: true }).click();
    await expect(browser).toHaveURL(/WR-000144/);
  });

  test('[allwork-records-details] Open details reads the record card or refuses in words', async ({ app, screen }) => {
    await app.open('/all-work');
    await dismissMorningBrief(screen);
    await expect(screen.getByText('Census complete')).toBeVisible({ timeout: 30_000 });
    const before = await screen.getByRole('button', { name: 'Open details' }).count();
    expect(before).toBeGreaterThan(0);
    await screen.getByRole('button', { name: 'Open details' }).first().click();
    // The press must change something a partner can see: the census settles again and the pressed row either
    // offers its disposition actions (one fewer Open details) or the page states why it could not read the card.
    await expect(screen.getByText('Census complete')).toBeVisible({ timeout: 60_000 });
    await expect(screen.getByRole('button', { name: 'Open details' })).toHaveCount(before - 1, { timeout: 30_000 });
  });

  test('[allwork-delivery-stages] the delivery stages table lists each work request and Evidence opens its record', async ({ app, agent, screen }) => {
    await app.open('/all-work');
    await dismissMorningBrief(screen);
    await expect(screen.getByText('Census complete')).toBeVisible({ timeout: 30_000 });
    const table = screen.getByRole('table', { name: 'Delivery stages' });
    await expect(table).toBeVisible();
    for (const name of ['Record', 'Planned', 'Approved', 'Reference verified', 'Merged', 'Released', 'Activated', 'Consumer proven', 'Evidence']) {
      await expect(table.getByRole('columnheader', { name })).toBeVisible();
    }
    await expect(screen.getByText(/^\d+ work request\(s\) on this page$/).first()).toBeVisible();
    const rows = await table.getByRole('row').count();
    expect(rows).toBeGreaterThan(1);
    await agent.act('Press Evidence on the row for WR-000144');
    const dialog = screen.getByRole('dialog', { name: 'WR-000144' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText('Stages', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Closure', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Reason', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: /Close/ }).click();
    await expect(dialog).toBeHidden();
  });
});

describe('area C2: Work Requests', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  test('[wr-open] a Work Request opens by ref, and a missing ref is refused plainly', async ({ app, agent, browser, screen, api }) => {
    await app.open('/work-requests');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'Eligible Work Requests' })).toBeVisible({ timeout: 30_000 });
    await agent.act('Type {ref} into Open a Work Request and press Open', { params: { ref: unique('WR-000144') } });
    await expect(screen.getByText(/WR-000144 · captured/i)).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByText('Synthetic staging MCP catalog route proof').first()).toBeVisible();
    await expect(browser).toHaveURL(/work_request=WR-000144/);
    const stored: any = await (await api('/api/system-work/WR-000144')).json();
    expect(JSON.stringify(stored)).toContain('Synthetic staging MCP catalog route proof');
    // Reload keeps the record open from the URL.
    await app.open('/work-requests?work_request=WR-000144');
    await expect(screen.getByText(/WR-000144 · captured/i)).toBeVisible({ timeout: 30_000 });
    // A ref that does not exist is refused in words.
    await screen.getByLabel('Open a Work Request').fill('WR-999999');
    await screen.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(screen.getByRole('alert').filter({ hasText: /not found|unavailable/i })).toBeVisible({ timeout: 30_000 });
  });

  test('[wr-report-problem] reporting a system problem records a concern and shows its Work Request', async ({ app, agent, screen, api }) => {
    const title = unique(`E2E ${Date.now()} read-only check`);
    await app.open('/work-requests');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'Eligible Work Requests' })).toBeVisible({ timeout: 30_000 });
    await agent.act('Press Report a system problem');
    const dialog = screen.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Report a system problem' })).toBeVisible();
    await dialog.getByLabel(/^Situation/).fill('E2E synthetic report, read-only check, no action needed.');
    await dialog.getByLabel('Short name').fill(title.value);
    await dialog.getByLabel('Desired result').fill('E2E nothing changes; this is a harmless staging check.');
    await dialog.getByLabel(/How we.ll know/).fill('The concern is recorded and shows a Work Request number.');
    await dialog.getByRole('button', { name: 'Record concern' }).click();
    // The write must be acknowledged: the dialog closes on success, or it states a refusal.
    await expect(screen.getByText(/^WR-\d+ · /).first()).toBeVisible({ timeout: 45_000 });
    await expect(dialog).toBeHidden();
    await expect(screen.getByText(title.value).first()).toBeVisible();
    const ref = (await screen.getByText(/^WR-\d+ · /).first().textContent())?.match(/^(WR-\d+)/)?.[1];
    expect(ref).toMatch(/^WR-\d+$/);
    const stored: any = await (await api(`/api/system-work/${ref}`)).json();
    expect(JSON.stringify(stored)).toContain(title.value);
  });
});

describe('area C2: Design Lab', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  test('[design-tabs] the four visual system section tabs each select and show their section', async ({ app, agent, screen }) => {
    await app.open('/design-lab');
    await dismissMorningBrief(screen);
    const tablist = screen.getByRole('tablist', { name: 'Visual system sections' });
    await expect(tablist).toBeVisible();
    await expect(tablist.getByRole('tab', { name: 'Tokens' })).toHaveAttribute('aria-selected', 'true');
    await expect(screen.getByRole('heading', { name: 'Colour by role' })).toBeVisible();
    await agent.act('Open the Components section of the Design Lab');
    await expect(tablist.getByRole('tab', { name: 'Components' })).toHaveAttribute('aria-selected', 'true');
    await expect(tablist.getByRole('tab', { name: 'Tokens' })).toHaveAttribute('aria-selected', 'false');
    await expect(screen.getByRole('heading', { name: 'The kit' })).toBeVisible();
    await expect(screen.getByRole('heading', { name: 'Colour by role' })).toBeHidden();
    for (const name of ['States', 'Rules', 'Tokens']) {
      await tablist.getByRole('tab', { name }).click();
      await expect(tablist.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
      await expect(screen.getByRole('tabpanel', { name })).toBeVisible();
    }
    await expect(screen.getByRole('heading', { name: 'Colour by role' })).toBeVisible();
    await agent.assert('The Design Lab shows the Tokens section again, with colour by role and type samples');
  });
});
