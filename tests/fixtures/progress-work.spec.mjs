import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const publication of ['unpublished', 'published', 'invalid-time', 'outage']) {
  test(`Progress work distinguishes ${publication} publication`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-17T12:00:00Z') });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://localhost') return route.abort();
      if (url.pathname === '/mcp') {
        const name = route.request().postDataJSON().params.name;
        if (name === 'read-progress-board' && publication === 'outage') return route.fulfill({ status: 503, body: '{}' });
        const payload = name === 'read-progress-board' ? { ok: true, snapshot: publication === 'unpublished' ? null : {
          board_id: 'carr-v5', version: 1, updated_at: publication === 'invalid-time' ? 'invalid' : '2026-10-17T11:59:00Z',
          snapshot_json: { title: 'Synthetic progress', tasks: {} },
        }, questions: [] } : name === 'read-session-identity' ? { sessions: [], permission_filtered: false } : {};
        return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
      }
      if (url.pathname === '/api/room/queue') return route.fulfill({ json: { live: true, projected_at: '2026-10-17T12:00:00Z', events: [] } });
      if (url.pathname === '/api/room/turns') return route.fulfill({ json: { ok: true, turns: [], latest_seq: 0, more: false,
        csrf_token: 'synthetic-fixture', actor: { slug: 'joe' } } });
      if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
      const file = url.pathname === '/control-room/progress/work' ? 'progress-work.html' : url.pathname.slice(1);
      try {
        const body = await readFile(new URL(`../../${file}`, import.meta.url));
        return route.fulfill({ body, contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      } catch { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto('http://localhost/control-room/progress/work?board=carr-v5');
    const status = page.locator('#workReadState');
    if (publication === 'unpublished') {
      await expect(status).toHaveAttribute('data-state', 'unpublished');
      await expect(status).toHaveText('No published snapshot');
      await expect(page.locator('#workSessions')).toBeVisible();
    } else if (publication === 'published') {
      await expect(status).toHaveAttribute('data-state', 'fresh');
      await expect(status).toHaveText('Updated 1m ago');
    } else if (publication === 'invalid-time') {
      await expect(status).toHaveAttribute('data-state', 'unknown');
      await expect(status).toHaveText('Update time unavailable');
    } else {
      await expect(status).toHaveAttribute('data-state', 'stale');
      await expect(status).toContainText('Work evidence unavailable');
    }
  });
}
