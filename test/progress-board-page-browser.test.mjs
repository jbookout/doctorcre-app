import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { handleDoctorcreRequest } from '../src/worker.js';

const boards = [{ board_id: 'carr-v5', title: 'System delivery' }, { board_id: 'demo-project', title: 'Demo project' }];
async function open(t, { unfinished = true, path = '/control-room/progress', boardRead = 'ready', rows = [], control, width = 390 } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  await page.clock.install();
  const calls = [], errors = []; let readState = boardRead;
  context.on('page', p => { p.setDefaultTimeout(7000); p.on('pageerror', e => errors.push(e.message)); });
  page.on('pageerror', e => errors.push(e.message));
  const env = {
    CARR: { fetch: async request => {
      if (new URL(request.url).pathname !== '/mcp') return new Response('{}');
      const rpc = (await request.json()).params; calls.push(rpc);
      let payload = { ok: true }, isError = false;
      if (rpc.name === 'list-progress-boards') payload = { schema: 'progress-board-directory.v1', boards };
      if (rpc.name === 'read-progress-board') {
        const board = boards.find(b => b.board_id === rpc.arguments.board_id);
        if (readState === 'failed') { payload = { error: 'board_read_failed' }; isError = true; }
        else payload = { snapshot: readState === 'missing' ? null : { board_id: board.board_id, version: 1,
          updated_at: '2026-10-02T08:00:00Z', snapshot_json: { title: board.title, tasks: {
            build: { title: `${board.title} task`, status: 'running' },
          } } }, questions: [] };
      }
      if (rpc.name === 'unfinished-work') {
        if (!unfinished) { payload = { error: 'unknown_tool', tool: 'unfinished-work' }; isError = true; }
        else {
          const args = rpc.arguments;
          const items = rows.filter(row => row.completed === Boolean(args.live_library)
            && (!args.text || row.title.includes(args.text)));
          payload = { schema: 'unfinished-work.v1', items, coverage: [], census_complete: true };
        }
      }
      return Response.json({ result: { isError, content: [{ text: JSON.stringify(payload) }] } });
    } },
    ASSETS: { fetch: async request => {
      const path = new URL(request.url).pathname;
      try { return new Response(await readFile(new URL('..' + path, import.meta.url)), {
        headers: { 'content-type': /\.m?js$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' },
      }); } catch { return new Response('Not found', { status: 404 }); }
    } },
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const response = await handleDoctorcreRequest(new Request(new URL(incoming.url, origin), {
        method: incoming.method, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }), env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { outgoing.writeHead(500); outgoing.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/mcp' && control && await control(route, route.request().postDataJSON().params)) return;
    return route.continue();
  });
  await page.goto(`${origin}${path}`);
  return { page, context, calls, errors, setRows: value => { rows = value; }, recover: () => { readState = 'ready'; } };
}

for (const unfinished of [false, true]) test(`board tile opens its page and published task flow with unfinishedWork ${unfinished ? 'available' : 'unavailable'}`, async t => {
  const { page, context, errors } = await open(t, { unfinished });
  await page.locator('[data-board-id="carr-v5"]').waitFor();
  const link = page.locator('[data-board-id="carr-v5"]');
  const target = await link.getAttribute('target');
  const opened = target === '_blank' ? context.waitForEvent('page') : null;
  await link.click();
  const board = opened ? await opened : page;
  await board.locator('#board-title').filter({ hasText: 'System delivery' }).waitFor();
  assert.equal(await board.locator('#board-flow [data-task-id="build"]').count(), 1, 'published task remains visible');
  assert.equal(new URL(board.url()).pathname, '/control-room/progress/board/carr-v5');
  assert.equal(await board.locator('#board-flow .flow-stage').count(), 6);
  assert.equal(await board.locator('.directory-panel').isVisible(), false);
  if (!unfinished) {
    assert.match(await board.locator('#system-work-error').textContent(), /System work updates unavailable/);
    assert.equal(await board.locator('#system-work-retry').isVisible(), true);
  }
  assert.deepEqual(errors, []);
});

for (const id of ['carr-v5', 'demo-project']) test(`legacy query redirects to the ${id} board page`, async t => {
  const { page, errors } = await open(t, { path: `/control-room/progress?board=${id}&view=flow` });
  await page.locator('#board-flow [data-task-id="build"]').waitFor();
  assert.equal(new URL(page.url()).pathname, `/control-room/progress/board/${id}`);
  assert.equal(new URL(page.url()).search, '?view=flow');
  assert.deepEqual(errors, []);
});

for (const boardRead of ['missing', 'failed']) test(`${boardRead} board read stays on its page with error and working retry`, async t => {
  const { page, errors, recover } = await open(t, { boardRead, unfinished: false, path: '/control-room/progress/board/demo-project' });
  await page.locator('#board-error').waitFor();
  assert.match(await page.locator('#board-error').textContent(), boardRead === 'missing' ? /not been published/ : /Could not load board/);
  assert.equal(new URL(page.url()).pathname, '/control-room/progress/board/demo-project');
  assert.equal(await page.locator('.directory-panel').isVisible(), false);
  recover();
  await page.locator('#board-retry').click();
  await page.locator('#board-flow [data-task-id="build"]').waitFor();
  assert.equal(await page.locator('#board-title').textContent(), 'Demo project');
  assert.equal(await page.locator('#board-error').isVisible(), false);
  assert.deepEqual(errors, []);
});

const workRow = (id, completed = false) => ({ id, kind: 'loop', source: 'synthetic.loop',
  title: `Synthetic ${id}`, state: completed ? 'done' : 'open', completed,
  age: 1, last_activity_at: '2026-10-02T08:00:00Z', available_triage_actions: [] });
const systemPath = '/control-room/progress/board/carr-v5';
async function panelTasks(page, ids) {
  await page.waitForFunction(expected => {
    const actual = [...document.querySelectorAll('#system-work-flow [data-task-id]')].map(n => n.dataset.taskId).sort();
    return JSON.stringify(actual) === JSON.stringify(expected.slice().sort());
  }, ids.map(id => `loop:${id}`));
  assert.equal(await page.locator('#system-work-count').textContent(), `${ids.length} TASK${ids.length === 1 ? '' : 'S'}`);
}

for (const denied of ['unfinished-work', 'read-progress-board']) {
  for (const order of ['denial-first', 'success-first']) test(`${denied} sign-out clears both flows (${order}) and recovers`, async t => {
    let active = false, release;
    const held = new Promise(resolve => { release = resolve; });
    const { page, errors } = await open(t, { path: systemPath, rows: [workRow('open')], control: async (route, rpc) => {
      if (!active || !['unfinished-work', 'read-progress-board'].includes(rpc.name)) return false;
      const isDenied = rpc.name === denied;
      if ((order === 'denial-first') !== isDenied) await held;
      if (isDenied) await route.fulfill({ status: 401, body: '{}' });
      else await route.continue();
      return true;
    } });
    await page.locator('#board-flow [data-task-id="build"]').waitFor();
    await panelTasks(page, ['open']);
    active = true;
    const success = order === 'success-first'
      ? page.waitForResponse(response => response.url().endsWith('/mcp') && response.status() === 200) : null;
    await page.clock.runFor(15000);
    if (order === 'denial-first') {
      await page.locator(denied === 'unfinished-work' ? '#system-work-error' : '#board-error').waitFor();
    } else {
      await success;
    }
    release();
    await page.locator('#board-sign-in').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#board-flow [data-task-id], #system-work-flow [data-task-id], .work-card').length === 0);
    // Give the previously held successful response time to arrive and render.
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#board-flow [data-task-id], #system-work-flow [data-task-id], .work-card').count(), 0);
    assert.equal(await page.locator('#system-work-coverage').textContent(), '');
    active = false;
    await page.locator('#board-retry').click();
    await page.locator('#board-flow [data-task-id="build"]').waitFor();
    await panelTasks(page, ['open']);
    assert.equal(await page.locator('#board-sign-in').isVisible(), false);
    assert.deepEqual(errors, []);
  });
}

test('Library pipeline membership and count follow mode, filters, and automatic refresh', async t => {
  const { page, setRows, errors } = await open(t, { path: systemPath, rows: [workRow('open'), workRow('done', true)] });
  await panelTasks(page, ['open', 'done']);
  await page.locator('#live-library').click();
  await page.locator('#system-work-cards [data-work-id="done"]').waitFor();
  await panelTasks(page, ['done']);
  setRows([workRow('open'), ...Array.from({ length: 12 }, (_, i) => workRow(`done-${i}`, true))]);
  await page.clock.runFor(15000);
  await panelTasks(page, Array.from({ length: 12 }, (_, i) => `done-${i}`));
  await page.locator('[name="text"]').fill('done-11');
  await page.locator('#system-work-filters').getByRole('button', { name: 'Search', exact: true }).click();
  await panelTasks(page, ['done-11']);
  await page.locator('#live-library').click();
  const recent = ['done-0', 'done-1', 'done-10', 'done-11', 'done-2', 'done-3', 'done-4', 'done-5', 'done-6', 'done-7'];
  await panelTasks(page, recent);
  await page.locator('[name="text"]').fill('open');
  await page.locator('#system-work-filters').getByRole('button', { name: 'Search', exact: true }).click();
  await panelTasks(page, ['open', ...recent]);
  assert.deepEqual(errors, []);
});

test('Library can render before the first unfinished read and rejects its late response', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { page, errors } = await open(t, { path: systemPath, rows: [workRow('open'), workRow('done', true)],
    control: async (route, rpc) => {
      if (rpc.name !== 'unfinished-work' || rpc.arguments.live_library) return false;
      await held; await route.continue(); return true;
    } });
  await page.locator('#live-library').click();
  await panelTasks(page, ['done']);
  release();
  await page.waitForLoadState('networkidle');
  await panelTasks(page, ['done']);
  assert.deepEqual(errors, []);
});

for (const failed of ['unfinished-work', 'read-progress-board']) test(`${failed} service failure preserves the independent flow and recovers`, async t => {
  let active = false;
  const { page, errors } = await open(t, { path: systemPath, rows: [workRow('open')],
    control: async (route, rpc) => {
      if (!active || rpc.name !== failed) return false;
      await route.fulfill({ status: 503, body: '{}' }); return true;
    } });
  await page.locator('#board-flow [data-task-id="build"]').waitFor();
  await panelTasks(page, ['open']);
  active = true;
  await page.clock.runFor(15000);
  await page.locator(failed === 'unfinished-work' ? '#system-work-error' : '#board-error').waitFor();
  assert.equal(await page.locator('#board-flow [data-task-id="build"]').count(), 1);
  await panelTasks(page, ['open']);
  assert.equal(await page.locator('#board-sign-in').isVisible(), false);
  active = false;
  await page.clock.runFor(15000);
  await page.waitForFunction(() => document.querySelector('#board-error').hidden && document.querySelector('#system-work-error').hidden);
  assert.deepEqual(errors, []);
});

for (const empty of [false, true]) test(`automatic refresh keeps keyboard position when a census task is removed (${empty ? 'empty' : 'remaining'} result)`, async t => {
  const { page, setRows, errors } = await open(t, { path: systemPath, rows: [workRow('remove'), workRow('keep')] });
  await panelTasks(page, ['remove', 'keep']);
  await page.locator('#system-work-flow [data-task-id="loop:remove"]').focus();
  setRows(empty ? [] : [workRow('keep')]);
  await page.clock.runFor(15000);
  await panelTasks(page, empty ? [] : ['keep']);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'system-work-title');
  assert.deepEqual(errors, []);
});

for (const width of [390, 1440]) {
  for (const change of ['updated', 'removed', 'empty']) test(`Live work keeps keyboard position during automatic refresh (${width}px, ${change})`, async t => {
    const released = { title: 'Synthetic release', summary: 'Original summary', status: 'done', stage: 'live', evidence: 'https://example.com/synthetic-delivery', work_request: 'WR-101' };
    let tasks = { keep: { ...released, title: 'Other release' }, released };
    let version = 1;
    const { page, errors } = await open(t, { width, path: '/control-room/progress/board/demo-project', control: async (route, rpc) => {
      if (rpc.name !== 'read-progress-board') return false;
      const payload = { snapshot: { board_id: 'demo-project', version,
        updated_at: '2026-10-02T08:00:00Z', snapshot_json: { title: 'Demo project', tasks } }, questions: [] };
      await route.fulfill({ json: { result: { content: [{ text: JSON.stringify(payload) }] } } });
      return true;
    } });
    const card = page.locator('.completed-card').filter({ hasText: 'Synthetic release' });
    await card.waitFor();
    await card.focus();
    await card.evaluate(node => { window.focusedLiveCard = node; });
    tasks = change === 'updated' ? { released: { ...released, summary: 'Updated summary', work_request: 'WR-102' }, keep: tasks.keep }
      : change === 'removed' ? { keep: tasks.keep } : {};
    version++;
    await page.clock.runFor(15000);
    await page.waitForFunction(() => document.querySelector('#board-meta').textContent.includes('Version 2'));
    if (change === 'updated') {
      assert.match(await card.textContent(), /Updated summary/);
      assert.equal(await card.evaluate(node => node === document.activeElement), true);
      assert.equal(await card.evaluate(node => node === window.focusedLiveCard), true, 'retain the same card by task identity');
      await page.keyboard.press('Enter');
      await page.waitForURL('**/control-room/progress/work?board=demo-project&task=released&work_request=WR-102');
    } else {
      assert.equal(await page.locator('.completed-card').count(), change === 'removed' ? 1 : 0);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'completed-title');
    }
    assert.deepEqual(errors, []);
  });
}
