import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { relationshipNetworkFixture } from '../../js/relationship-network-fixture.js';

const root = new URL('../../', import.meta.url);
const at = '2026-10-04T17:00:00Z';
const board = { snapshot: { board_id: 'density-demo', version: 1, updated_at: at,
  snapshot_json: { kind: 'project', title: 'Synthetic delivery', tasks: {
    review: { title: 'Resolve synthetic review feedback', status: 'running', stage: 'review', health: 'blocked',
      blocked_reason: 'Review feedback needs a repair', updated_at: at, stage_entered_at: at },
  } } }, questions: [] };

for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
  test.describe(`${width} ${theme}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    test.beforeEach(async ({ page }) => {
      await page.clock.install({ time: new Date(at) });
      await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://localhost') return route.abort();
        if (url.pathname === '/api/v1/business/relationships') {
          const network = relationshipNetworkFixture(at);
          network.nodes[0].name = 'Synthetic staging Healthcare Lending North Partners';
          network.nodes[3].name = 'Synthetic staging Healthcare Lending South Partners';
          return route.fulfill({ json: network });
        }
        if (['/api/system-work/session','/auth/session'].includes(url.pathname)) return route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}});
    if (url.pathname === '/mcp') {
          const name = route.request().postDataJSON().params.name;
          const payload = name === 'read-progress-board' ? { ok: true, ...board }
            : name === 'list-progress-boards' ? { schema: 'progress-board-directory.v1', boards: [{ board_id: 'density-demo', title: 'Synthetic delivery' }] }
            : name === 'deal-room-board' ? { deals: [], actor: 'joe' } : { ok: true, items: [], events: [], cursor: null };
          return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
        }
        if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
        const file = { '/deals': 'pipeline.html', '/relationships': 'relationships.html', '/control-room/progress/board/density-demo': 'progress-board.html' }[url.pathname] || url.pathname.slice(1);
        try {
          let body = await readFile(new URL(file, root));
          return route.fulfill({ body, contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
        } catch { return route.fulfill({ status: 404, body: '' }); }
      });
    });

    async function capture(page, subject) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.evaluate(() => document.fonts.ready);
      const dir = process.env.S8_SCREENSHOTS || new URL('out/test-artifacts/s8-final/', root).pathname;
      await mkdir(dir, { recursive: true });
      await page.screenshot({ path: `${dir}/${subject}-${width}-${theme}.png`, animations: 'disabled' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }

    test('Deals lists keep touch targets readable and owner beside the stage', async ({ page }) => {
      await page.goto('http://localhost/deals');
      await expect(page.locator('.kanban-card').first()).toBeVisible();
      await page.locator('#listView').click();
      await capture(page, 'deals-list');
      const row = page.locator('.deal-row').filter({ hasNot: page.locator('.auto-move') }).first();
      const target = row.getByRole('button').first();
      expect((await target.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await expect(row.locator('.next-line')).toBeVisible();
      expect(await row.evaluate(node => [...node.children].every(child => {
        const box = child.getBoundingClientRect(), row = node.getBoundingClientRect();
        return box.top >= row.top && box.bottom <= row.bottom;
      }))).toBe(true);
      if (width === 390) {
        const stage = await row.locator(':scope > span').first().boundingBox();
        const owner = await row.locator(':scope > span').last().boundingBox();
        expect(Math.abs(stage.y - owner.y)).toBeLessThan(2);
      }
      await target.click();
      await expect(page.locator('#recordPanel')).toBeVisible();
    });

    test('Relationships phone opens with full distinguishable connection names', async ({ page }) => {
      await page.goto('http://localhost/relationships?mode=live');
      await expect(page.locator('#networkNodes button').first()).toBeVisible();
      await capture(page, 'relationships');
      if (width === 390) {
        await expect(page.locator('.relationship-graph-panel')).toBeHidden();
        const directory = await page.locator('.relationship-directory').boundingBox();
        const intros = await page.locator('.relationship-intros').boundingBox();
        expect(directory.y).toBeLessThan(intros.y);
        expect(await page.locator('.relationship-directory').evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('.relationship-intros')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
        const names = await page.locator('#networkNodes strong').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, fits: node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight })));
        expect(names.every(name => name.fits)).toBe(true);
        expect(names.some(name => name.text.endsWith('North Partners'))).toBe(true);
        expect(names.some(name => name.text.endsWith('South Partners'))).toBe(true);
        await page.locator('#networkNodes button').first().click();
        await expect(page.locator('.relationship-dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#networkNodes button').first()).toBeFocused();
      }
    });

    test('Progress keeps all five work views visible and reachable without horizontal scrolling', async ({ page }) => {
      const populated = structuredClone(board);
      Object.assign(populated.snapshot.snapshot_json.tasks, {
        build: { title: 'Build the synthetic export', status: 'running', updated_at: at },
        completed: { title: 'Use the synthetic export', status: 'done' },
        ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`queue-${i}`, {
          title: `Synthetic queued outcome ${i}`, status: 'queued',
        }])),
      });
      await page.route('**/mcp', async route => {
        if (route.request().postDataJSON().params.name !== 'read-progress-board') return route.fallback();
        return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...populated }) }] } } });
      });
      await page.goto('http://localhost/control-room/progress/board/density-demo?mode=live');
      const menu = page.getByRole('navigation', { name: 'Work views', exact: true });
      const options = menu.getByRole('button');
      await expect(options).toHaveCount(5);
      for (const label of ['Active', 'Completed', 'Needs a hand', 'Queue', 'History']) {
        const geometry = await options.evaluateAll(nodes => nodes.map(node => {
          const rect = node.getBoundingClientRect();
          const menu = node.parentElement.getBoundingClientRect();
          return { label: node.textContent, inside: rect.left >= Math.max(0, menu.left)
            && rect.right <= Math.min(innerWidth, menu.right) && rect.top >= 0 && rect.bottom <= innerHeight };
        }));
        expect(geometry.every(option => option.inside), JSON.stringify(geometry)).toBe(true);
        expect(await menu.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
          && document.body.scrollWidth <= innerWidth)).toBe(true);
        const option = options.filter({ hasText: new RegExp(`^${label} ·`) });
        await option.click();
        await expect(option).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#board-stages .board-card').first()).toBeVisible();
        await capture(page, `progress-view-${label.toLowerCase().replaceAll(' ', '-')}`);
        const publication = page.locator('#board-publication');
        await expect(publication).toBeVisible();
        await expect(publication).toContainText('Snapshot generation 1');
        await expect(publication).toContainText('Source revision not supplied');
        await expect(publication.locator('time')).toHaveAttribute('datetime', at);
        await publication.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
        expect(await publication.evaluate(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
        })).toBe(true);
        await capture(page, `progress-publication-${label.toLowerCase().replaceAll(' ', '-')}`);
        await menu.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
      }
    });

    test('Progress puts populated stages first and explains an empty filter', async ({ page }) => {
      await page.goto('http://localhost/control-room/progress/board/density-demo?mode=live');
      await expect(page.locator('#board-stages .board-card')).toBeVisible();
      await expect(page.locator('#directory-error')).toBeHidden();
      await page.getByRole('button', { name: 'Needs a hand · 1', exact: true }).click();
      await expect(page.locator('#board-stages .board-card')).toBeVisible();
      await capture(page, 'progress-board');
      await expect(page.locator('#board-stages .column').first()).toHaveAttribute('data-stage', 'review');
      await expect(page.locator('#board-stages .column-empty')).toHaveCount(0);
      if (width === 390) expect((await page.locator('#board-stages .board-card').boundingBox()).y).toBeLessThan(650);
      await page.locator('#filter-stage').selectOption('queued');
      await expect(page.locator('#board-stages')).toContainText('No tasks match these filters.');
    });
  });
}
