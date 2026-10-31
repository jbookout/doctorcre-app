import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../../js/fixture-client.js';
import { routeContract } from '../../js/routes.js';

const root = new URL('../../', import.meta.url);
for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
  test(`partner reviews and adopts conventions at ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json', root))).toString('base64')}`, docContext: false });
    const queue = await fixture.governanceQueue();
    queue.pending_convention_proposals[0].statement += '\n<script>window.demoInjected = true</script>\n<b>Demo literal text</b>';
    const writes = [];
    let outcome = 'conflict';
    const methods = { 'read-progress-board': 'readProgressBoard', 'governance-queue': 'governanceQueue', 'deal-room-board': 'getBoard' };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://localhost') return route.abort();
      if (['/auth/session', '/api/system-work/session'].includes(url.pathname))
        return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-session' } });
      if (url.pathname === '/mcp') {
        const { name, arguments: args } = route.request().postDataJSON().params;
        let payload;
        if (name === 'adopt-rule') {
          writes.push({ args, csrf: route.request().headers()['x-carr-csrf'] });
          if (outcome === 'conflict') {
            queue.pending_convention_proposals[0].base_version = 9;
            queue.pending_convention_proposals[0].approve_with.base_version = 9;
            queue.pending_convention_proposals[0].statement += '\nDemo revision nine.';
            payload = { error: 'version_conflict' };
          } else if (outcome === 'unknown') payload = { ok: true };
          else {
            payload = { ok: true, rule_id: null, retired_rule_ids: ['demo-retired-rule'], retired_section_id: args.section_id };
            queue.pending_convention_proposals = queue.pending_convention_proposals.filter(row => row.section_id !== args.section_id);
            queue.counts.pending_convention_proposals--; queue.counts.total--;
          }
        } else if (name === 'governance-queue') payload = queue;
        else {
          const method = methods[name] || name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          payload = typeof fixture[method] === 'function' ? await fixture[method](args) : {};
        }
        return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
      const file = routeContract.routes[url.pathname] || url.pathname.slice(1);
      try {
        return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
      } catch { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto('http://localhost/control-room?mode=live&tab=approvals');
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await expect(page.locator('#tabApprovals')).toHaveAttribute('aria-selected', 'true');
    const cards = page.locator('[data-convention]');
    await expect(cards).toHaveCount(2);
    const first = cards.filter({ has: page.getByRole('heading', { name: 'demo-1', exact: true }) });
    await expect(first.locator('.convention-body')).toHaveText(queue.pending_convention_proposals[0].statement);
    await expect(first.locator('script,b')).toHaveCount(0);
    await first.getByRole('button', { name: 'Adopt', exact: true }).click();
    expect(writes).toHaveLength(0);
    await first.getByRole('textbox', { name: 'Why', exact: true }).fill('Demo partner review.');
    await page.screenshot({ path: test.info().outputPath(`approvals-${width}-${theme}.png`), fullPage: true });
    await first.getByRole('button', { name: 'Adopt', exact: true }).click();
    await expect(page.locator('#conventionStatus')).toContainText('look again');
    await expect(first.locator('.convention-body')).toContainText('Demo revision nine.');
    expect(writes).toHaveLength(1);
    outcome = 'unknown';
    await first.getByRole('textbox', { name: 'Why', exact: true }).fill('Demo reviewed revision nine.');
    await first.getByRole('button', { name: 'Adopt', exact: true }).click();
    await expect(first.getByRole('button', { name: 'Check outcome' })).toBeEnabled();
    await expect(first.getByRole('textbox')).toBeDisabled();
    await expect(page.locator('#conventionStatus')).not.toHaveText('Adopted');
    expect(writes[1].args).toEqual({ section_id: queue.pending_convention_proposals[0].section_id, base_version: 9,
      reason: 'Demo reviewed revision nine.', idempotency_key: expect.any(String) });
    expect(writes[1].args.idempotency_key).not.toBe(writes[0].args.idempotency_key);
    outcome = 'success';
    await first.getByRole('button', { name: 'Check outcome' }).click();
    await expect(page.locator('#conventionStatus')).toHaveText('Adopted');
    await expect(cards).toHaveCount(1);
    expect(writes[2]).toEqual(writes[1]);
    expect(writes.every(write => write.csrf === 'synthetic-session')).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`adopted-${width}-${theme}.png`), fullPage: true });
  });
}
