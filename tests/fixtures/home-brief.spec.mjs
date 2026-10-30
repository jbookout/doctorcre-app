import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { createFixtureClient } from '../../js/fixture-client.js';
import { relationshipNetworkFixture } from '../../js/relationship-network-fixture.js';
import { routeContract } from '../../js/routes.js';

for (const state of ['populated', 'empty', 'loading', 'unavailable', 'call-only', 'email-only', 'unavailable-call', 'unavailable-email']) for (const width of [1440, 390]) for (const theme of ['light', 'dark']) test(`Home decisions ${state} at ${width} in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.clock.install({ time: new Date('2026-10-01T15:00:00Z') });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../../data/board-seed.json', import.meta.url))).toString('base64')}` });
  const agenda = await client.getHomeAgenda();
  agenda.deals = agenda.deals.slice(0, 2).map((deal, i) => ({ ...deal, next_actions: [{ id: `synthetic-${i}`, description: `${['Send the lease summary', 'Review the revised plan'][i]}`, due_on: null, status: 'open', owner: 'joe' }] }));
  const followups = { schema_version: 'post-call-followups.v1', send: false, candidates: [{
    id: 'synthetic-call-task', session_id: 'synthetic-call', kind: 'assigned_action',
    deal_id: agenda.deals[0].id, deal_name: agenda.deals[0].name,
    payload: { deal_id: agenda.deals[0].id, assignee: 'joe', action: 'Call Morgan Demo about the loan', due_on: '2026-10-02' },
    evidence_quote: 'Follow up with the lender.', created_at: '2026-10-01T13:00:00Z',
  }] };
  const emails = await client.listEmailProposals({ limit: 50 });
  emails.proposals.forEach(row => { row.source.sender = 'Dana Demo'; row.source.occurred_at = '2026-10-01T13:00:00Z'; });
  const briefData = await client.morningBrief();
  briefData.sections.today = { state: 'ready', items: agenda.deals.map((deal, i) => ({ subject_type: 'deal', subject_id: deal.id, subject_name: deal.name, what: `${['Send the lease summary', 'Review the revised plan'][i]}`, due_on: '2026-10-01' })) };
  let releaseCalls, releaseEmails;
  const callGate = new Promise(resolve => { releaseCalls = resolve; });
  const emailGate = new Promise(resolve => { releaseEmails = resolve; });
  if (['empty', 'email-only'].includes(state)) followups.candidates = [];
  if (['empty', 'call-only'].includes(state)) emails.proposals = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (['/auth/session', '/api/system-work/session'].includes(url.pathname)) return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } });
    if (url.pathname === '/mcp') {
      const { name, arguments: args = {} } = route.request().postDataJSON().params;
      if (name === 'read-post-call-followups' && state === 'loading') await callGate;
      if (name === 'list-email-proposals' && !args.mode && state === 'loading') await emailGate;
      if ((name === 'read-post-call-followups' && ['unavailable', 'unavailable-call'].includes(state)) || (name === 'list-email-proposals' && !args.mode && ['unavailable', 'unavailable-email'].includes(state))) return route.fulfill({ status: 503, json: { error: 'synthetic_unavailable' } });
      const payload = name === 'read-home-agenda' ? agenda
        : name === 'deal-room-board' ? { ...await client.getBoard(args), deals: agenda.deals.map((deal, i) => ({ ...deal, next_step: `${['Send the lease summary', 'Review the revised plan'][i]}`, next_date: '2026-09-30' })) }
        : name === 'morning-brief' ? briefData
        : name === 'lead-board' ? { leads: [] }
        : name === 'read-post-call-followups' ? followups
        : name === 'read-invoice-tracker' ? { schema_version: 'invoice-tracker.v1', actor: 'joe', entries: [], observed_at: '2026-10-01T15:00:00Z' }
        : name === 'list-email-thread-filings' ? { filings: [] }
        : name === 'read-call-outcomes' ? { schema_version: 'call-outcomes.v1', calls: [], send: false }
        : name === 'list-email-proposals' ? { schema_version: args.mode === 'recent_outcomes' ? 'email-reply-outcomes.v1' : 'email-proposals.v1', proposals: args.mode ? [] : emails.proposals, send: false, more: false, next_cursor: null }
        : name === 'today-triage' ? { items: agenda.deals.map((deal, i) => ({ subject_type: 'deal', subject_id: deal.id, subject_name: deal.name, what: `${['Send the lease summary', 'Review the revised plan'][i]}`, due_on: '2026-10-01' })) }
        : { ok: true, items: [], proposals: [], filings: [], events: [], calls: [], send: false };
      return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
    }
    if (url.pathname === '/api/v1/business/relationships') return route.fulfill({ json: relationshipNetworkFixture(new Date().toISOString()) });
    if (url.pathname.startsWith('/api/') || url.pathname === '/pipeline/changes') return route.fulfill({ json: { events: [], cursor: null } });
    const file = routeContract.routes[url.pathname] || url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(`../../${file}`, import.meta.url)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/?mode=live');
  await page.getByRole('button', { name: 'Skip walkthrough', exact: true }).click();
  const dir = new URL('../../test/review-artifacts/home-decisions/', import.meta.url);
  await mkdir(dir, { recursive: true });
  const capture = () => page.screenshot({ path: `${dir.pathname}${state}-${width}-${theme}.png`, fullPage: true });
  if (state === 'loading') {
    await expect(page.locator('#homeCallTasks .home-followup-skeleton')).toBeVisible();
    await expect(page.locator('#homeEmailFollowups .home-followup-skeleton')).toBeVisible();
    const before = await page.locator('#homeEmailFollowups').boundingBox();
    await capture();
    releaseCalls(); releaseEmails();
    await expect(page.locator('#homeCallTasks article')).toHaveCount(1);
    const after = await page.locator('#homeEmailFollowups').boundingBox();
    expect(after.y).toBeCloseTo(before.y, 0);
    return;
  }
  if (state !== 'populated') {
    await expect(page.locator('#refreshHome')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#homeEmailFollowups')).toHaveAttribute('aria-busy', 'false');
    if (['empty', 'email-only'].includes(state)) await expect(page.locator('#homeCallTasks')).toContainText('No call follow-ups');
    else if (['unavailable', 'unavailable-call'].includes(state)) await expect(page.locator('#homeCallTasks')).toContainText('Call follow-ups unavailable');
    else await expect(page.locator('#homeCallTasks article')).toHaveCount(1);
    if (['empty', 'call-only'].includes(state)) await expect(page.locator('#homeEmailFollowups')).toContainText('No email follow-ups');
    else if (['unavailable', 'unavailable-email'].includes(state)) await expect(page.locator('#homeEmailFollowups')).toContainText('Could not load email follow-ups');
    else await expect(page.locator('#homeEmailFollowups article')).toHaveCount(width === 390 ? 1 : 2);
    await capture();
    return;
  }
  const brief = page.getByRole('complementary', { name: 'Your brief' });
  await expect(brief.locator('a')).toHaveCount(2);
  await expect(page.locator('#refreshHome')).toHaveAttribute('aria-busy', 'false');
  if (width === 1440) {
    const days = page.locator('.home-week .home-day');
    await expect(days).toHaveCount(7);
    const columns = await days.evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect();
      return { date: node.getAttribute('data-home-week-date'), top: box.top, left: box.left, width: box.width };
    }));
    expect(columns.map(day => day.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
    for (const [index, day] of columns.entries()) {
      expect(day.top).toBeCloseTo(columns[0].top, 0);
      expect(day.width).toBeCloseTo(columns[0].width, 0);
      if (index) expect(day.left).toBeGreaterThan(columns[index - 1].left);
    }
  }
  if (width === 390) {
    const briefBox = await page.locator('#homeCallTasks').boundingBox();
    const header = await page.locator('.app-layout-tabbar').boundingBox();
    expect(briefBox.y).toBeGreaterThanOrEqual(header.y + header.height);
    expect(briefBox.y).toBeLessThan(header.y + header.height + 80);
    const sections = await page.locator('main .home-panel:visible').all();
    for (const section of sections) expect((await section.boundingBox()).y).toBeGreaterThanOrEqual(briefBox.y);
  }
  const call = page.getByRole('region', { name: 'Call tasks to review' });
  const email = page.getByRole('region', { name: 'Email follow-ups', exact: true });
  await expect(call.getByText('Call Morgan Demo about the loan', { exact: true })).toBeVisible();
  await expect(email.locator('article')).toHaveCount(width === 390 ? 1 : 2);
  const order = await page.locator('.home-hero, #homeCallTasks, #homeEmailFollowups, #homeBrief, #homeMeetings, #dealAttention, #homeCalendar, #dealCounts').evaluateAll(nodes => nodes.map(node => node.id || 'hero'));
  expect(order).toEqual(['hero', 'homeCallTasks', 'homeEmailFollowups', 'homeBrief', 'homeMeetings', 'dealAttention', 'homeCalendar', 'dealCounts']);
  const panels = [call, email, brief, page.locator('#dealAttention'), page.locator('#homeCalendar'), page.locator('#dealCounts')];
  for (let i = 1; i < panels.length; i++) {
    const previous = await panels[i - 1].boundingBox(), current = await panels[i].boundingBox();
    expect(current.y).toBeGreaterThanOrEqual(previous.y + previous.height);
  }
  await expect(call.locator('.home-call-source')).toContainText('From your call with');
  await expect(call.locator('.home-call-source')).toContainText('2h ago');
  await expect(call.locator('.home-call-task-controls')).toContainText('Due Oct 2');
  await expect(call.locator('time[datetime="2026-10-01T13:00:00Z"]')).toHaveCount(1);
  await expect(email.locator('.email-source').first()).toContainText("From Dana Demo's email, 2h ago");
  await expect(page.locator('footer[aria-label="Deal counts"]')).toContainText('Active deals: 2');
  for (const title of ['Send the lease summary', 'Review the revised plan']) {
    await expect(page.getByText(title, { exact: true }).filter({ visible: true })).toHaveCount(1);
    expect((await page.locator('body').innerText()).split(title).length - 1).toBe(1);
  }
  await expect(brief.getByRole('button', { name: /Complete/ })).toHaveCount(0);
  await expect(page.locator('#homeCalendar .home-item-type')).toHaveCount(0);
  await expect(page.locator('#appToday')).not.toContainText('Send the lease summary');
  await expect(page.locator('#appTodayOwners')).toBeHidden();
  await expect(page.locator('#appTodayNext time')).toHaveAttribute('datetime', '2026-10-01');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.locator('.home-grid').scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Refresh past-client touches', exact: true })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0));
  await capture();
  if (width === 390) {
    await email.getByRole('button', { name: 'Show 1 more', exact: true }).click();
    await expect(email.locator('article')).toHaveCount(2);
  }
  await call.locator('summary').click();
  await email.locator('article').first().locator('summary').click();
  await page.clock.fastForward(60 * 60 * 1000);
  await expect(call.locator('details')).toHaveAttribute('open', '');
  await expect(email.locator('article').first().locator('details')).toHaveAttribute('open', '');
  await expect(call.locator('.home-call-source')).toContainText('3h ago');
  await expect(email.locator('.email-source').first()).toContainText('3h ago');
});
