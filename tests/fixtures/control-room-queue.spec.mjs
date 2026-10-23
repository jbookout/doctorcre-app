import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../../js/fixture-client.js';
import { routeContract } from '../../js/routes.js';

const root = new URL('../../', import.meta.url);
const methods = { 'unfinished-work': 'unfinishedWork', 'incident-board': 'incidentBoard',
  'governance-queue': 'governanceQueue', 'schedule-board': 'scheduleBoard',
  'current-work-item': 'currentWorkItem', 'current-work-requests': 'currentWorkRequests',
  'notification-feed': 'notificationFeed', 'deal-room-board': 'getBoard',
  'list-feature-switches': 'listFeatureSwitches', 'list-doc-suggestions': 'listDocSuggestions',
  'list-notifications': 'listNotifications', 'read-progress-board': 'readProgressBoard',
  'list-progress-boards': 'listProgressBoards' };

for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
  test(`Queue pending, unavailable and full title at ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await page.clock.install({ time: new Date('2026-10-17T12:00:00Z') });
    const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json', root))).toString('base64')}` });
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const title = 'Synthetic proposal to make the queue easier to scan while preserving every word of this unusually long record title. '.repeat(5);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://localhost') return route.abort();
      if (url.pathname === '/api/system-work/session') return route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}});
      if (url.pathname === '/mcp') {
        const { name, arguments: args } = route.request().postDataJSON().params;
        if (name === 'incident-board') await pending;
        let payload = methods[name] ? await fixture[methods[name]](args) : {};
        if (name === 'unfinished-work') payload = { ...payload, items: [
          { kind: 'work_request', id: 'WR-000910', identity: { human_ref: 'WR-000910' }, state: 'in_progress', title: 'Evidence graph', owner: 'joe' },
          { kind: 'retrieval_proposal', id: 'proposal-1', identity: {}, state: 'pending', title, owner: 'joe' },
        ] };
        if (name === 'work-request-card') {
          expect(args).toEqual({ work_request: 'WR-000910' });
          return route.fulfill({ json: { result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'work_request_not_found' }) }] } } });
        }
        return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
      const file = routeContract.routes[url.pathname] || url.pathname.slice(1);
      try {
        return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
      } catch { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto('http://localhost/control-room?mode=live&tab=queue');
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const skeleton = page.locator('#crQueueList .cr-list-skeleton');
    try {
      await expect(skeleton).toBeVisible();
      const rows = skeleton.locator('.cr-skeleton-row');
      expect(await rows.count()).toBeGreaterThan(0);
      expect((await rows.first().boundingBox()).height).toBeGreaterThanOrEqual(width === 390 ? 52 : 40);
      await expect(page.getByText('Reading queue…', { exact: true })).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath('loading.png') });
    } finally { release(); }
    await page.locator('#crQueueList [data-kind="work_request"]').click();
    const pane = page.locator('#crDetail');
    await expect(pane.locator('[data-detail-unavailable]')).toContainText('Work request not found');
    await expect(pane.locator('.cr-next')).toContainText('Unavailable');
    await expect(pane).not.toContainText('None recorded');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: test.info().outputPath('short-title.png') });
    await expect(pane.locator('.cr-title-expand, .cr-title-collapse, .cr-detail-heading summary')).toHaveCount(0);
    await expect(pane.locator('#crDetailTitle')).toHaveText('Evidence graph');
    const order = await pane.evaluate(node => [...node.children].map(child => child.className));
    expect(order.indexOf('state-block cr-detail-availability')).toBeLessThan(order.indexOf('cr-next'));
    await page.screenshot({ path: test.info().outputPath('unavailable.png') });
    await pane.locator('[data-detail-close]:visible').first().click();
    await page.locator('#crQueueList [data-kind="retrieval_proposal"]').click();
    await expect(pane.locator('[data-detail-unavailable]')).toContainText('Detail read unavailable');
    await expect(pane.locator('.cr-next')).toContainText('Unavailable');
    await expect(pane.locator('.cr-props dt').filter({ hasText: /^(Kind|State)$/ })).toHaveCount(0);
    const heading = pane.locator('#crDetailTitle');
    await page.evaluate(() => document.fonts.ready);
    await expect(heading).toHaveText(title.trim());
    expect(await heading.evaluate(node => ({ fits: node.scrollHeight <= node.clientHeight + 1, clamp: getComputedStyle(node).webkitLineClamp }))).toEqual({ fits: true, clamp: 'none' });
    await expect(pane.locator('.cr-title-expand, .cr-title-collapse')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('full-title.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
