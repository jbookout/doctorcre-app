import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, waitForAsync } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { createFixtureClient } from '../js/fixture-client.js';

async function open(t, tab = 'views', { width = 1280, theme = 'dark', pending = false } = {}) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ timezoneId: 'UTC', viewport: { width, height: width === 390 ? 844 : 960 }, reducedMotion: 'reduce' });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  await page.clock.install({ time: new Date('2026-10-20T12:00:00Z') });
  const seedUrl = `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}`;
  const fixture = await createFixtureClient({ seedUrl });
  const state = { censusUnavailable: false, queueReads: 0, live: true };
  let release;
  const census = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== server.url) return route.abort();
    if (url.pathname === '/mcp') {
      const rpc = route.request().postDataJSON().params;
      const boardCensus = rpc.name === 'unfinished-work' && Object.hasOwn(rpc.arguments, 'live_library');
      if (pending && boardCensus) await census;
      if (state.censusUnavailable && boardCensus) return route.fulfill({ status: 503, body: '{}' });
      if (rpc.name === 'unfinished-work' && !boardCensus) state.queueReads++;
      const method = { 'read-room-queue': 'roomQueue', 'read-room': 'roomTurns', 'read-session-identity': 'sessionIdentity', 'read-dispatch-history': 'dispatchHistory' }[rpc.name] || rpc.name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      let payload = typeof fixture[method] === 'function' ? await fixture[method](rpc.arguments || {}) : { ok: true };
      if (rpc.name === 'unfinished-work' && !rpc.arguments.live_library) {
        payload.items = [{ ...payload.items[0], id: 'INC-DEMO', kind: 'incident', title: 'Demo blocked incident',
          state: 'blocked', owner: 'dell', work_request_ref: 'WR-000901',
          blocked_reason: 'Demo incident source stopped', last_progress: 'Demo incident checked' }];
      }
      if (rpc.name === 'read-room-queue') {
        payload.projected_at = '2026-10-20T11:55:00Z';
        payload.live = state.live;
      }
      if (rpc.name === 'current-work-item') {
        payload.current = payload.current.map(row => ({ ...row, owner: 'joe', blocker: { code: 'dependency', detail: 'Demo linked WR dependency' } }));
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { content: [{ text: JSON.stringify(payload) }] } }) });
    }
    if (['/api/system-work/session','/auth/session'].includes(url.pathname)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ actor: { slug: 'joe' }, csrf_token: 'synthetic-test-token' }) });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  await page.goto(`${server.url}/control-room?mode=live&tab=${tab}`);
  if (!pending) await page.locator('[data-attention-id="incident:INC-DEMO"]').waitFor({ state: 'attached' });
  return { page, state, release };
}

async function capture(page, name) {
  if (!process.env.PR299_CAPTURE) return;
  const dir = new URL(`../out/test-artifacts/pr299-taste/${process.env.PR299_CAPTURE}/`, import.meta.url);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: new URL(`${name}.png`, dir).pathname });
}

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
  test(`Doc and close reserve an opaque row above incident headings at ${width} ${theme}`, async t => {
    const { page } = await open(t, 'views', { width, theme });
    await capture(page, `attention-${width}-${theme}`);
    await page.locator('[data-attention-id="incident:INC-DEMO"] button').click();
    await page.locator('#jobDialog #docPresence').waitFor();
    const dialog = page.locator('#jobDialog');
    const opening = await dialog.evaluate(node => ({
      titleTop: node.querySelector('#jobTitle').getBoundingClientRect().top,
      controlsBottom: node.querySelector('#docPresence').parentElement.getBoundingClientRect().bottom,
    }));
    assert.ok(opening.titleTop >= opening.controlsBottom, 'the title starts below the reserved controls row');
    await capture(page, `incident-open-${width}-${theme}`);
    await dialog.locator('details').evaluate(node => { node.open = true; });
    await dialog.evaluate(node => { node.scrollTop = 70; });
    await capture(page, `incident-scroll-${width}-${theme}`);
    const layout = await dialog.evaluate(node => {
      const doc = node.querySelector('#docOpen').getBoundingClientRect();
      const close = node.querySelector('#jobClose').getBoundingClientRect();
      const header = node.querySelector('#docPresence').parentElement;
      return { doc: { top: doc.top, bottom: doc.bottom, right: doc.right },
        close: { top: close.top, left: close.left }, headerBackground: getComputedStyle(header).backgroundColor,
        sameRow: header.matches('header') && header.contains(node.querySelector('#jobClose')), scroll: node.scrollTop };
    });
    assert.equal(layout.sameRow, true, 'Doc and the close control share a reserved header row');
    assert.notEqual(layout.headerBackground, 'rgba(0, 0, 0, 0)', 'the controls row is opaque');
    assert.ok(Math.abs(layout.doc.top - layout.close.top) < 2, 'both controls stay on the same row while scrolling');
    assert.ok(layout.doc.right < layout.close.left, 'controls cannot overlap');
    assert.ok(layout.doc.top >= 0 && layout.doc.bottom < 844, 'Doc remains reachable');
    await page.locator('#docOpen').click();
    await page.locator('#docClose').click();
    assert.equal(await page.locator('#docOpen').evaluate(node => node === document.activeElement), true);
    await page.locator('#jobClose').click();
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.locator('[data-attention-open]').first().evaluate(node => node === document.activeElement), true);
  });
}

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
  test(`Attention leads with item facts and groups linked Work Request facts compactly at ${width} ${theme}`, async t => {
    const { page } = await open(t, 'views', { width, theme });
    await page.waitForFunction(() => document.querySelector('#crAttentionList')?.textContent.includes('claude'));
    const row = page.locator('[data-attention-id="incident:INC-DEMO"]');
    const layout = await row.evaluate(node => ({ height: node.getBoundingClientRect().height,
      labels: [...node.querySelectorAll('dt')].map(node => node.textContent) }));
    assert.ok(layout.height <= 360, `the attention row occupies ${layout.height}px, at most 360px`);
    assert.deepEqual(layout.labels.slice(0, 2), ['Blocker', 'Owner'], 'item blocker and owner lead the facts');
    const linked = row.getByRole('region', { name: 'Linked Work Request', exact: true });
    assert.equal(await linked.isVisible(), true, 'linked facts have their own explicit group');
    assert.match(await linked.innerText(), /joe.*Agent.*claude.*Blocker.*Demo linked WR dependency/s);
    const primary = row.locator(':scope > dl');
    assert.match(await primary.innerText(), /Blocker.*Demo incident source stopped.*Owner.*dell/s);
    assert.doesNotMatch(await primary.innerText(), /claude|Demo linked WR dependency/);
    const button = await row.getByRole('button', { name: 'Open details' }).boundingBox();
    assert.ok(button.height >= 44, 'the action retains a phone touch target');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
}

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
  test(`Attention reserves its pending layout and retries only a real census failure at ${width} ${theme}`, async t => {
    const { page, state, release } = await open(t, 'views', { width, theme, pending: true });
    await page.locator('#crViewsList [data-view]').first().waitFor();
    await capture(page, `pending-${width}-${theme}`);
    const list = page.locator('#crAttentionList');
    assert.doesNotMatch(await page.locator('#panelViews').innerText(), /unavailable|could not be read|try again/i,
      'an unfinished census does not report a failed read');
    assert.equal(await list.getAttribute('aria-busy'), 'true');
    const pendingHeight = (await list.boundingBox()).height;
    assert.ok(pendingHeight >= 240, 'pending reserves a full attention row');
    assert.equal(await list.getByRole('button', { name: 'Retry attention' }).count(), 0);
    release();
    await page.locator('[data-attention-id="incident:INC-DEMO"]').waitFor();
    assert.equal(await list.getAttribute('aria-busy'), 'false');
    assert.ok(Math.abs((await list.boundingBox()).height - pendingHeight) <= 96, 'the loaded row uses the reserved space');
    await page.locator('[data-attention-id="incident:INC-DEMO"] button').click();
    state.censusUnavailable = true;
    await page.clock.runFor(15001);
    await page.waitForFunction(() => document.querySelector('#crAttentionList [data-state="offline"]'));
    assert.match(await page.locator('#jobBody').innerText(), /Source unavailable.*Last-known/);
    await page.locator('#jobClose').click();
    await capture(page, `failed-${width}-${theme}`);
    const retry = list.getByRole('button', { name: 'Retry attention' });
    assert.equal(await retry.isVisible(), true, 'the failure has a local recovery action');
    const geometry = await list.evaluate(list => {
      const failure = list.querySelector('[data-state="offline"]');
      const action = failure.querySelector('[data-attention-retry]');
      const row = failure.getBoundingClientRect(), button = action.getBoundingClientRect();
      return { rowTop:row.top, rowBottom:row.bottom, buttonTop:button.top, buttonBottom:button.bottom };
    });
    assert.ok(geometry.buttonTop >= geometry.rowTop && geometry.buttonBottom <= geometry.rowBottom,
      'retry is next to the failure it recovers');
    state.censusUnavailable = false;
    await retry.click();
    await page.locator('[data-attention-id="incident:INC-DEMO"]').waitFor();
    assert.equal(await retry.count(), 0);
    assert.doesNotMatch(await page.locator('#crQueueCoverage').textContent(), /unavailable|Reading/i);
  });
}

test('linked Work Request facts stay separate from the selected incident in Attention and detail', async t => {
  const { page } = await open(t);
  const row = page.locator('[data-attention-id="incident:INC-DEMO"]');
  await page.waitForFunction(() => document.querySelector('#crAttentionList')?.textContent.includes('claude'));
  const fact = async (node, label) => node.getByText(label, { exact: true }).evaluate(node => node.nextElementSibling.textContent);
  assert.equal(await fact(row.locator(':scope > dl'), 'Owner'), 'dell');
  assert.equal(await fact(row.locator(':scope > dl'), 'Blocker'), 'Demo incident source stopped');
  const linked = row.getByRole('region', { name: 'Linked Work Request', exact: true });
  assert.equal(await fact(linked, 'Owner'), 'joe');
  assert.equal(await fact(linked, 'Blocker'), 'Demo linked WR dependency');
  await row.getByRole('button', { name: 'Open details' }).click();
  const detail = page.locator('#jobBody');
  assert.equal(await fact(detail, 'Owner'), 'dell');
  assert.equal(await fact(detail, 'Blocker'), 'Demo incident source stopped');
  assert.equal(await fact(detail, 'Linked WR owner'), 'joe');
  assert.equal(await fact(detail, 'Linked WR blocker'), 'Demo linked WR dependency');
});

test('board census failure invalidates Attention and its open detail while Queue succeeds', async t => {
  const { page, state } = await open(t);
  await page.locator('[data-attention-id="incident:INC-DEMO"] button').click();
  const before = state.queueReads;
  state.censusUnavailable = true;
  await page.clock.runFor(15001);
  await page.waitForFunction(() => document.querySelector('#system-work-error')?.hidden === false);
  await waitForAsync(page, async () => {
    const { view } = await import('/js/control-room.js');
    return view.sequence >= 2 && view.status === 'ready';
  });
  assert.ok(state.queueReads > before, 'Queue reread succeeded independently');
  assert.equal(await page.evaluate(async () => (await import('/js/control-room.js')).view.queue.state), 'read');
  assert.equal(await page.locator('#crAttentionList [data-attention-id]').count(), 0);
  assert.match(await page.locator('#crAttentionList').innerText(), /Attention work could not be read/);
  assert.match(await page.locator('#jobBody').innerText(), /Source unavailable.*Last-known/);
  assert.equal(await page.locator('#jobTitle').innerText(), 'Demo blocked incident');
  state.censusUnavailable = false;
  await page.clock.runFor(15001);
  await page.locator('[data-attention-id="incident:INC-DEMO"]').waitFor();
  assert.doesNotMatch(await page.locator('#jobBody').innerText(), /Source unavailable/);
});

test('an old running timestamp does not record a blocked Attention state', async () => {
  const { boardView } = await import('../js/progress-board-model.js');
  const { attentionTasks } = await import('../js/control-room-workspace-model.js');
  const { cards } = boardView({ snapshot: { board_id: 'demo', version: 1, snapshot_json: { tasks: {
    running: { status: 'running', title: 'Demo slow work', updated_at: '2026-10-01T12:00:00Z' },
    blocked: { status: 'blocked', title: 'Demo recorded blocker' },
    failed: { status: 'failed', title: 'Demo recorded failure' },
  } } } }, new Date('2026-10-20T12:00:00Z'));
  assert.equal(cards.find(row => row.id === 'running').health, 'blocked', 'the board retains its age warning');
  assert.deepEqual(attentionTasks(cards).map(row => row.id), ['failed', 'blocked']);
});

test('Agents freshness uses relative time and exposes the absolute observation on hover', async t => {
  const { page, state } = await open(t, 'agents');
  const line = page.locator('#modelRoomFreshness');
  await page.waitForFunction(() => document.querySelector('#modelRoomFreshness')?.dataset.state === 'live');
  assert.match(await line.innerText(), /Updated 5 minutes ago/);
  assert.doesNotMatch(await line.innerText(), /2026-10-20T/);
  assert.match(await line.getAttribute('title'), /2026/);
  assert.match(await line.getAttribute('title'), /11:55/);
  state.live = false;
  await page.locator('#modelRoomRetry').click();
  await page.waitForFunction(() => document.querySelector('#modelRoomFreshness')?.dataset.state === 'stale');
  assert.match(await line.innerText(), /Last updated 5 minutes ago.*last recorded assignments/);
  assert.doesNotMatch(await line.innerText(), /2026-10-20T/);
  assert.match(await line.getAttribute('title'), /11:55/);
});
