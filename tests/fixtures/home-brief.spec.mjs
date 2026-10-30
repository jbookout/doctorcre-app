import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { createFixtureClient } from '../../js/fixture-client.js';
import { relationshipNetworkFixture } from '../../js/relationship-network-fixture.js';
import { routeContract } from '../../js/routes.js';

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) test(`Home gives each task one place at ${width} in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.clock.install({ time: new Date('2026-10-01T15:00:00Z') });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../../data/board-seed.json', import.meta.url))).toString('base64')}` });
  const agenda = await client.getHomeAgenda();
  agenda.deals = agenda.deals.slice(0, 2).map((deal, i) => ({ ...deal, next_actions: [{ id: `synthetic-${i}`, description: `Synthetic follow-up ${i + 1}`, due_on: null, status: 'open', owner: 'joe' }] }));
  const briefData = await client.morningBrief();
  briefData.sections.today = { state: 'ready', items: agenda.deals.map((deal, i) => ({ subject_type: 'deal', subject_id: deal.id, subject_name: deal.name, what: `Synthetic follow-up ${i + 1}`, due_on: '2026-10-01' })) };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (['/auth/session', '/api/system-work/session'].includes(url.pathname)) return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } });
    if (url.pathname === '/mcp') {
      const { name, arguments: args = {} } = route.request().postDataJSON().params;
      const payload = name === 'read-home-agenda' ? agenda
        : name === 'deal-room-board' ? { ...await client.getBoard(args), deals: agenda.deals.map((deal, i) => ({ ...deal, next_step: `Synthetic follow-up ${i + 1}`, next_date: '2026-09-30' })) }
        : name === 'morning-brief' ? briefData
        : name === 'lead-board' ? { leads: [] }
        : name === 'read-post-call-followups' ? await client.getPostCallFollowups()
        : name === 'read-invoice-tracker' ? { schema_version: 'invoice-tracker.v1', actor: 'joe', entries: [], observed_at: '2026-10-01T15:00:00Z' }
        : name === 'list-email-thread-filings' ? { filings: [] }
        : name === 'read-call-outcomes' ? { schema_version: 'call-outcomes.v1', calls: [], send: false }
        : name === 'list-email-proposals' ? { schema_version: args.mode === 'recent_outcomes' ? 'email-reply-outcomes.v1' : 'email-proposals.v1', proposals: [], send: false, more: false, next_cursor: null }
        : name === 'today-triage' ? { items: agenda.deals.map((deal, i) => ({ subject_type: 'deal', subject_id: deal.id, subject_name: deal.name, what: `Synthetic follow-up ${i + 1}`, due_on: '2026-10-01' })) }
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
    const briefBox = await brief.boundingBox();
    const header = await page.locator('.app-layout-tabbar').boundingBox();
    expect(briefBox.y).toBeGreaterThanOrEqual(header.y + header.height);
    expect(briefBox.y).toBeLessThan(header.y + header.height + 80);
    const sections = await page.locator('main .home-panel:visible').all();
    for (const section of sections) expect((await section.boundingBox()).y).toBeGreaterThanOrEqual(briefBox.y);
  }
  for (const title of ['Synthetic follow-up 1', 'Synthetic follow-up 2']) {
    await expect(page.getByText(title, { exact: true }).filter({ visible: true })).toHaveCount(1);
    expect((await page.locator('body').innerText()).split(title).length - 1).toBe(1);
  }
  await expect(brief.getByRole('button', { name: /Complete/ })).toHaveCount(0);
  await expect(page.locator('#appToday')).not.toContainText('Synthetic follow-up');
  await expect(page.locator('#appTodayOwners')).toBeHidden();
  await expect(page.locator('#appTodayNext time')).toHaveAttribute('datetime', '2026-10-01');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const dir = new URL('../../out/test-artifacts/home-brief/', import.meta.url);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir.pathname}home-${width}-${theme}.png`, fullPage: true });
});
