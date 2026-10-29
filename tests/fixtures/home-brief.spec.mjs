import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { createFixtureClient } from '../../js/fixture-client.js';
import { routeContract } from '../../js/routes.js';

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) test(`Home gives each task one place at ${width} in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.clock.install({ time: new Date('2026-10-01T15:00:00Z') });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../../data/board-seed.json', import.meta.url))).toString('base64')}` });
  const agenda = await client.getHomeAgenda();
  agenda.deals = agenda.deals.slice(0, 2).map((deal, i) => ({ ...deal, next_actions: [{ id: `synthetic-${i}`, description: `Synthetic follow-up ${i + 1}`, due_on: null, status: 'open', owner: 'joe' }] }));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (['/auth/session', '/api/system-work/session'].includes(url.pathname)) return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } });
    if (url.pathname === '/mcp') {
      const { name, arguments: args = {} } = route.request().postDataJSON().params;
      const payload = name === 'read-home-agenda' ? agenda
        : name === 'deal-room-board' ? await client.getBoard(args)
        : name === 'morning-brief' ? await client.morningBrief()
        : name === 'today-triage' ? { items: agenda.deals.map((deal, i) => ({ subject_type: 'deal', subject_id: deal.id, subject_name: deal.name, what: `Synthetic follow-up ${i + 1}`, due_on: '2026-10-01' })) }
        : { ok: true, items: [], proposals: [], filings: [], events: [], calls: [], send: false };
      return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/pipeline/changes') return route.fulfill({ json: { events: [], cursor: null } });
    const file = routeContract.routes[url.pathname] || url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(`../../${file}`, import.meta.url)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/?mode=live');
  const brief = page.getByRole('complementary', { name: 'Your brief' });
  await expect(brief.locator('a')).toHaveCount(2);
  await expect(page.locator('#refreshHome')).toHaveAttribute('aria-busy', 'false');
  if (width === 390) {
    const briefBox = await brief.boundingBox();
    const header = await page.locator('.app-layout-tabbar').boundingBox();
    expect(briefBox.y).toBeGreaterThanOrEqual(header.y + header.height);
    expect(briefBox.y).toBeLessThan(header.y + header.height + 80);
    const sections = await page.locator('main .home-panel:visible').all();
    for (const section of sections) expect((await section.boundingBox()).y).toBeGreaterThanOrEqual(briefBox.y);
  }
  for (const title of ['Synthetic follow-up 1', 'Synthetic follow-up 2']) await expect(page.getByText(title, { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(brief.getByRole('button', { name: /Complete/ })).toHaveCount(0);
  await expect(page.locator('#appToday')).not.toContainText('Synthetic follow-up');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const dir = new URL('../../out/test-artifacts/home-brief/', import.meta.url);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir.pathname}home-${width}-${theme}.png`, fullPage: true });
});
