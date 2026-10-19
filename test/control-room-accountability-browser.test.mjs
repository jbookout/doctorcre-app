import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { createFixtureClient } from '../js/fixture-client.js';

const root = new URL('../', import.meta.url);

async function open(t, width, tab = 'views', theme = 'dark') {
  const server = await startFixtureServer({ env: process.env.ACCOUNTABILITY_BUILT ? { DOCTORCRE_FIXTURE_ROOT: new URL('../dist/site/', import.meta.url).pathname } : {} });
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
  await page.clock.install();
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  const seedUrl = `data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json', root))).toString('base64')}`;
  const fixture = await createFixtureClient({ seedUrl });
  const state = { progress: 'Demo validation finished; export has not started', unavailable: false };
  const methods = { 'governance-queue': 'governanceQueue', 'schedule-board': 'scheduleBoard', 'read-resource-dashboard': 'readResourceDashboard', 'read-room-queue': 'roomQueue', 'read-room': 'roomTurns', 'read-session-identity': 'sessionIdentity', 'read-dispatch-history': 'dispatchHistory' };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== server.url) return route.abort();
    if (url.pathname === '/mcp') {
      const rpc = route.request().postDataJSON().params;
      if (state.unavailable && rpc.name === 'unfinished-work') return route.fulfill({ status: 503, body: '{}' });
      const method = methods[rpc.name] || rpc.name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      let payload = typeof fixture[method] === 'function' ? await fixture[method](rpc.arguments || {}) : { ok: true };
      if (rpc.name === 'unfinished-work' && !rpc.arguments.live_library) {
        payload.items = payload.items.slice(0, 3).map((row, index) => ({ ...row,
          title: ['Demo export needs its source', 'Demo search index is rebuilding', 'Demo review needs a decision'][index],
          state: ['failed', 'in_progress', 'blocked'][index], owner: ['cx-app', 'cx-search', 'joe'][index],
          blocked_reason: index === 0 ? 'Demo source did not answer' : 'Demo reviewer unavailable',
          last_progress: index === 0 ? state.progress : 'Demo review packet is ready',
        }));
      }
      if (rpc.name === 'read-room-queue') {
        payload.events = payload.events.slice(0, 2).map((event, index) => ({ ...event,
          summary: index ? 'Demo index batches are being checked' : 'Demo validation finished before the source stopped',
          card: { ...event.card, title: index ? 'Demo search index' : 'Demo export', target: index ? 'cx-search' : 'cx-app',
            status: index ? 'working' : 'blocked', effective_model: index ? { id: 'demo-model', effort: 'high' } : {},
          },
        }));
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { content: [{ text: JSON.stringify(payload) }] } }) });
    }
    if (url.pathname === '/api/system-work/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ actor: { slug: 'joe' }, csrf_token: 'synthetic-test-token' }) });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  await page.goto(`${server.url}/control-room?mode=live&tab=${tab}`);
  return { page, state };
}

for (const theme of ['dark', 'light']) for (const width of [1440, 390]) test(`attention keeps a failed job once and opens that exact item at ${width} ${theme}`, async t => {
  const { page } = await open(t, width, 'views', theme);
  const failed = page.locator('[data-attention-id="work_request:WR-000901"]');
  await failed.waitFor({ timeout: 5000 });
  assert.equal(await failed.count(), 1);
  assert.match(await failed.innerText(), /Demo source did not answer/);
  assert.match(await failed.innerText(), /Demo validation finished; export has not started/);
  assert.match(await failed.innerText(), /Agent\s+claude/, 'the held-work executor wins over the census owner');
  assert.match(await failed.innerText(), /Owner\s+joe/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir(new URL('out/test-artifacts/slice8/', root), { recursive: true });
  await page.screenshot({ path: new URL(`out/test-artifacts/slice8/attention-${width}${theme==='light'?'-light':''}.png`, root).pathname, fullPage: false });
  await failed.getByRole('button', { name: 'Open details' }).click();
  assert.equal(await page.locator('#jobTitle').innerText(), 'Demo export needs its source');
  assert.equal(await page.locator('#jobBody').getByText('Owner', { exact: true }).evaluate(node => node.nextElementSibling.textContent), 'joe');
  assert.match(await page.locator('#jobBody').innerText(), /Demo source did not answer/);
  assert.match(await page.locator('#jobBody').innerText(), /Demo validation finished; export has not started/);
  await page.getByRole('button', { name: 'Close job details' }).click();
  assert.equal(await failed.getByRole('button').evaluate(node => node === document.activeElement), true);
});

for (const theme of ['dark', 'light']) for (const width of [1440, 390]) test(`agents show accountable desks, progress, and honest model facts at ${width} ${theme}`, async t => {
  const { page } = await open(t, width, 'agents', theme);
  const cards = page.locator('#modelRoomAssignments .assignment-card');
  await cards.first().waitFor({ timeout: 5000 });
  assert.match(await cards.first().innerText(), /cx-app/);
  assert.match(await cards.first().innerText(), /Model\s+unknown/);
  assert.match(await cards.first().innerText(), /Effort\s+unknown/);
  assert.match(await cards.nth(1).innerText(), /demo-model/);
  assert.match(await cards.nth(1).innerText(), /Effort\s+high/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir(new URL('out/test-artifacts/slice8/', root), { recursive: true });
  await page.screenshot({ path: new URL(`out/test-artifacts/slice8/agents-${width}${theme==='light'?'-light':''}.png`, root).pathname, fullPage: false });
  await cards.first().getByRole('button', { name: 'Open details' }).click();
  assert.equal(await page.locator('#jobTitle').innerText(), 'Demo export');
  assert.match(await page.locator('#jobBody').innerText(), /Demo validation finished before the source stopped/);
});

test('an open attention detail follows its selected job through refresh and source failure', async t => {
  const { page, state } = await open(t, 1440);
  await page.locator('[data-attention-id="work_request:WR-000901"] button').click();
  state.progress = 'Demo source responded; export retry is next';
  await page.clock.runFor(15001);
  await page.waitForFunction(() => document.querySelector('#jobBody')?.textContent.includes('Demo source responded; export retry is next'));
  assert.equal(await page.locator('#jobTitle').innerText(), 'Demo export needs its source');
  state.unavailable = true;
  await page.clock.runFor(15001);
  await page.waitForFunction(() => document.querySelector('#crAttentionList')?.textContent.includes('Attention work could not be read'));
  assert.match(await page.locator('#jobBody').innerText(), /Source unavailable.*Last-known/);
  assert.equal(await page.locator('#jobTitle').innerText(), 'Demo export needs its source');
});
