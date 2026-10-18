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

for (const width of [1440, 390]) for (const theme of ['dark', 'light']) for (const empty of [false, true]) {
  test(`C3 ${empty ? 'empty' : 'rows'} at ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.clock.install({ time: new Date('2026-10-17T12:00:00Z') });
    const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json', root))).toString('base64')}` });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://localhost') return route.abort();
      if (url.pathname === '/mcp') {
        const { name, arguments: args } = route.request().postDataJSON().params;
        let payload = methods[name] ? await fixture[methods[name]](args) : {};
        if (empty && name === 'unfinished-work') payload = { ...payload, items: [] };
        if (empty && name === 'notification-feed') payload = { ...payload, notifications: [], unread_count: 0 };
        return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
      }
      if (url.pathname === '/api/system-work/current') return route.fulfill({ json: { ok: true, data: { ok: true, items: empty ? [] : [{ human_ref: 'WR-000901', state: 'needs_joe', title: 'Synthetic request for a short decision', next_human_action: 'Choose the next step' }] } } });
      if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
      const file = routeContract.routes[url.pathname] || url.pathname.slice(1);
      try {
        return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
      } catch { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto('http://localhost/control-room?mode=live&tab=triage');
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const measurements = [];
    for (const key of ['triage', 'inbox', 'waiting']) {
      const tab = page.locator(`[data-tab-key="${key}"]`);
      if (!(await tab.isVisible())) await page.locator('#appSidebarToggle').click();
      await tab.click();
      const panel = page.locator(`#${await tab.getAttribute('aria-controls')}`);
      await expect(panel.locator(empty ? '[data-state="empty"]' : '.cr-row').first()).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`${key}-${width}-${theme}.png`) });
      measurements.push(await panel.evaluate((node, empty) => {
        const state = node.querySelector('[data-state="empty"]');
        return { key: node.id, introHeight: node.querySelector('header').getBoundingClientRect().height,
          rowHeights: [...node.querySelectorAll('.cr-row')].map(row => row.getBoundingClientRect().height),
          titleLines: [...node.querySelectorAll('.cr-row-title')].map(title => getComputedStyle(title).whiteSpace),
          empty: empty ? { border: getComputedStyle(state).borderTopWidth, background: getComputedStyle(state).backgroundColor, height: state.getBoundingClientRect().height } : null };
      }, empty));
      if (key === 'triage') await expect(panel).toContainText('Defects are listed in Views, under Bugs.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    for (const result of measurements) {
      expect(result.introHeight, result.key).toBeLessThan(65);
      if (empty) {
        expect(result.empty.border, result.key).toBe('0px');
        expect(result.empty.background, result.key).toBe('rgba(0, 0, 0, 0)');
        expect(result.empty.height, result.key).toBeLessThan(150);
      } else {
        expect(result.rowHeights.length, result.key).toBeGreaterThan(0);
        for (const height of result.rowHeights) expect(height, result.key).toBeLessThanOrEqual(44);
        expect(result.titleLines.every(value => value === 'nowrap'), result.key).toBe(true);
      }
    }
    expect(errors).toEqual([]);
  });
}
