import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { createFixtureClient } from '../js/fixture-client.js';

async function open(t, tab = 'views') {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.clock.install({ time: new Date('2026-10-20T12:00:00Z') });
  const seedUrl = `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}`;
  const fixture = await createFixtureClient({ seedUrl });
  const state = { censusUnavailable: false, queueReads: 0 };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== server.url) return route.abort();
    if (url.pathname === '/mcp') {
      const rpc = route.request().postDataJSON().params;
      const boardCensus = rpc.name === 'unfinished-work' && Object.hasOwn(rpc.arguments, 'live_library');
      if (state.censusUnavailable && boardCensus) return route.fulfill({ status: 503, body: '{}' });
      if (rpc.name === 'unfinished-work' && !boardCensus) state.queueReads++;
      const method = rpc.name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      let payload = typeof fixture[method] === 'function' ? await fixture[method](rpc.arguments || {}) : { ok: true };
      if (rpc.name === 'unfinished-work' && !rpc.arguments.live_library) {
        payload.items = [{ ...payload.items[0], id: 'INC-DEMO', kind: 'incident', title: 'Demo blocked incident',
          state: 'blocked', owner: 'dell', work_request_ref: 'WR-000901',
          blocked_reason: 'Demo incident source stopped', last_progress: 'Demo incident checked' }];
      }
      if (rpc.name === 'current-work-item') {
        payload.current = payload.current.map(row => ({ ...row, owner: 'joe', blocker: { code: 'dependency', detail: 'Demo linked WR dependency' } }));
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { content: [{ text: JSON.stringify(payload) }] } }) });
    }
    if (url.pathname === '/api/system-work/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ actor: { slug: 'joe' }, csrf_token: 'synthetic-test-token' }) });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  await page.goto(`${server.url}/control-room?mode=live&tab=${tab}`);
  await page.locator('[data-attention-id="incident:INC-DEMO"]').waitFor();
  return { page, state };
}

test('linked Work Request facts stay separate from the selected incident in Attention and detail', async t => {
  const { page } = await open(t);
  const row = page.locator('[data-attention-id="incident:INC-DEMO"]');
  await page.waitForFunction(() => document.querySelector('#crAttentionList')?.textContent.includes('claude'));
  const fact = async (node, label) => node.getByText(label, { exact: true }).evaluate(node => node.nextElementSibling.textContent);
  assert.equal(await fact(row, 'Owner'), 'dell');
  assert.equal(await fact(row, 'Blocker'), 'Demo incident source stopped');
  assert.equal(await fact(row, 'Linked WR owner'), 'joe');
  assert.equal(await fact(row, 'Linked WR blocker'), 'Demo linked WR dependency');
  await row.getByRole('button', { name: 'Open details' }).click();
  const detail = page.locator('#jobBody');
  assert.equal(await fact(detail, 'Owner'), 'dell');
  assert.equal(await fact(detail, 'Blocker'), 'Demo incident source stopped');
  assert.equal(await fact(detail, 'Linked WR owner'), 'joe');
  assert.equal(await fact(detail, 'Linked WR blocker'), 'Demo linked WR dependency');
});
