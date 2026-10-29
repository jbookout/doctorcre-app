import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import axe from 'axe-core';
import { handleDoctorcreRequest } from '../src/worker.js';
import { STAGES } from '../js/progress-board-model.js';
import costs from './fixtures/progress-board-costs.json' with { type: 'json' };
import hierarchy from './fixtures/progress-board-hierarchy.json' with { type: 'json' };
import workQueue from '../js/progress-work-queue-fixture.js';
import orchestratorSequence from './fixtures/progress-orchestrator.json' with {type:'json'};

const boards = [{ board_id: 'carr-v5', title: 'System delivery' }, { board_id: 'demo-project', title: 'Demo project' }];
async function open(t, { unfinished = true, path = '/control-room/progress', boardRead = 'ready', rows = [], control, width = 390, height = 900, costData, snapshotData, assetRoot, autoMount = true, timezoneId, setupPage } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height }, ...(timezoneId ? { timezoneId } : {}) });
  const context = page.context();
  await page.clock.install();
  const calls = [], errors = []; let readState = boardRead;
  context.on('page', p => { p.on('pageerror', e => errors.push(e.stack)); });
  page.on('pageerror', e => errors.push(e.stack));
  const env = {
    CARR: { fetch: async request => {
      if (['/api/system-work/session','/auth/session'].includes(new URL(request.url).pathname)) return Response.json({actor:{slug:'joe'},csrf_token:'synthetic-session'});
      if (new URL(request.url).pathname !== '/mcp') return new Response('{}');
      const rpc = (await request.json()).params; calls.push(rpc);
      let payload = { ok: true }, isError = false;
      if (rpc.name === 'list-progress-boards') payload = { schema: 'progress-board-directory.v1', boards };
      if (rpc.name === 'read-progress-board') {
        const board = boards.find(b => b.board_id === rpc.arguments.board_id) || (rpc.arguments.board_id === 'orchestrator' ? {board_id:'orchestrator',title:'Orchestrator'} : null);
        if (readState === 'failed') { payload = { error: 'board_read_failed' }; isError = true; }
        else payload = { snapshot: readState === 'missing' ? null : { board_id: board.board_id, version: 1,
          updated_at: '2026-10-02T08:00:00Z', snapshot_json: snapshotData || { title: board.title, costs: costData, tasks: {
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
      try { return new Response(await readFile(assetRoot ? new URL('.' + path, assetRoot) : new URL('..' + path, import.meta.url)), {
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
    if (route.request().isNavigationRequest() && !url.searchParams.has('mode')) {
      url.searchParams.set('mode', 'live');
      return route.fulfill({ status: 302, headers: { location: url.href } });
    }
    if (url.pathname === '/mcp' && control && await control(route, route.request().postDataJSON().params)) return;
    return route.continue();
  });
  if (!autoMount) await page.addInitScript(() => { window.__BOARD_NO_AUTOMOUNT = true; });
  const target = new URL(path, origin);
  if (!target.searchParams.has('mode')) target.searchParams.set('mode', 'live');
  await setupPage?.(page);
  await page.goto(target.href);
  return { page, context, calls, errors, setSnapshot: value => { snapshotData = value; }, setRows: value => { rows = value; }, recover: () => { readState = 'ready'; } };
}

for (const unfinished of [false, true]) test(`board tile opens its page and published task flow with unfinishedWork ${unfinished ? 'available' : 'unavailable'}`, async t => {
  const { page, context, errors } = await open(t, { unfinished });
  await page.locator('[data-board-id="carr-v5"]').waitFor({ state: 'attached' });
  await page.getByText('Published boards', { exact: true }).click();
  const link = page.locator('[data-board-id="carr-v5"]');
  const target = await link.getAttribute('target');
  const opened = target === '_blank' ? context.waitForEvent('page') : null;
  await link.click();
  const board = opened ? await opened : page;
  await board.locator('#board-title').filter({ hasText: 'System delivery' }).waitFor();
  assert.equal(await board.locator('#board-stages [data-card-id="build"]').count(), 1, 'published task remains visible');
  assert.equal(new URL(board.url()).pathname, '/control-room/progress/board/carr-v5');
  assert.deepEqual(await board.locator('#board-stages .column').evaluateAll(columns => columns.map(column => column.dataset.stage)), ['build']);
  assert.equal(await board.locator('.directory-panel').isVisible(), true, 'the canonical board retains its project selector');
  if (!unfinished) {
    assert.match(await board.locator('#system-work-error').textContent(), /System work updates unavailable/);
    assert.equal(await board.locator('#system-work-retry').isVisible(), true);
  }
  assert.deepEqual(errors, []);
});

for (const id of ['carr-v5', 'demo-project']) test(`legacy query redirects to the ${id} board page`, async t => {
  const { page, errors } = await open(t, { path: `/control-room/progress?board=${id}&view=flow` });
  await page.locator('#board-stages [data-card-id="build"]').waitFor();
  assert.equal(new URL(page.url()).pathname, `/control-room/progress/board/${id}`);
  assert.equal(new URL(page.url()).search, '?view=flow&mode=live');
  assert.deepEqual(errors, []);
});

for (const boardRead of ['missing', 'failed']) test(`${boardRead} board read stays on its page with error and working retry`, async t => {
  const { page, errors, recover } = await open(t, { boardRead, unfinished: false, path: '/control-room/progress/board/demo-project' });
  await page.locator('#board-error').waitFor();
  assert.match(await page.locator('#board-error').textContent(), boardRead === 'missing' ? /not been published/ : /Could not load board/);
  assert.equal(new URL(page.url()).pathname, '/control-room/progress/board/demo-project');
  assert.equal(await page.locator('.directory-panel').isVisible(), true, 'other published boards remain reachable when this read fails');
  recover();
  await page.locator('#board-retry').click();
  await page.locator('#board-stages [data-card-id="build"]').waitFor();
  assert.equal(await page.locator('#board-title').textContent(), 'Demo project');
  assert.equal(await page.locator('#board-error').isVisible(), false);
  assert.deepEqual(errors, []);
});

const workRow = (id, completed = false) => ({ id, kind: 'loop', source: 'synthetic.loop',
  title: `Synthetic ${id}`, state: completed ? 'done' : 'open', completed,
  age: 1, last_activity_at: '2026-10-02T08:00:00Z', available_triage_actions: [] });
const systemPath = '/control-room/progress/board/carr-v5';
async function hierarchyEvidence(page, state, width, theme) {
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  if (!process.env.HIERARCHY_EVIDENCE_DIR) return;
  await mkdir(process.env.HIERARCHY_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.HIERARCHY_EVIDENCE_DIR}/${state}-${width}-${theme}.png`, fullPage: true });
}

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
  test(`hierarchy keeps one heading when shell arrives after board at ${width}px ${theme}`, async t => {
    const { page, errors } = await open(t, { width, path: systemPath, snapshotData: hierarchy,
      setupPage: page => page.route('**/js/app-shell.js', async route => {
        await page.waitForFunction(() => document.querySelector('[data-hierarchy-id="WR14"]'));
        await route.continue();
      }) });
    await hierarchyEvidence(page, 'shell-after-board', width, theme);
    const headings = await page.locator('h1, h2').evaluateAll(nodes => nodes.filter(node =>
      node.textContent === 'Work Requests' && node.getBoundingClientRect().height > 1 &&
      getComputedStyle(node).clip === 'auto').map(node => ({ id: node.id, className: node.className,
        parentClass: node.parentElement.className })));
    assert.equal(headings.length, 1, `one visible Work Requests heading: ${JSON.stringify(headings)}`);
    assert.equal(await page.locator('#appSidebar .app-layout-sidebar-head h2').textContent(), 'Progress');
    assert.deepEqual(errors, []);
  });

  test(`hierarchy taste has one heading and reaches work promptly at ${width}px ${theme}`, async t => {
    const { page, errors } = await open(t, { width, path: systemPath, snapshotData: hierarchy });
    const first = page.locator('[data-hierarchy-id="WR14"]');
    await first.waitFor();
    await hierarchyEvidence(page, 'requests', width, theme);
    const headings = await page.locator('h1, h2').evaluateAll(nodes => nodes.filter(node =>
      node.textContent === 'Work Requests' && node.getBoundingClientRect().height > 1 &&
      getComputedStyle(node).clip === 'auto').length);
    assert.equal(headings, 1, 'one visible Work Requests heading');
    assert.equal(await page.locator('nav[aria-label="Breadcrumb"]').isVisible(), false, 'one hierarchy breadcrumb row');
    const firstY = (await first.boundingBox()).y;
    assert.ok(firstY < 380, `the first request starts at ${firstY}px, within 380px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
  });

  test(`hierarchy taste holds row skeletons while the census resolves first at ${width}px ${theme}`, async t => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const { page, errors } = await open(t, { width, path: '/control-room?mode=live&tab=boards',
      snapshotData: hierarchy, rows: Array.from({ length: 17 }, (_, index) => workRow(`pending-${index}`)),
      control: async (route, rpc) => {
        if (rpc.name !== 'read-progress-board') return false;
        await held; await route.continue(); return true;
      } });
    await page.waitForFunction(() => document.querySelector('#system-work-coverage')?.textContent.length > 0);
    await hierarchyEvidence(page, 'loading', width, theme);
    assert.equal(await page.locator('#board-stages [data-card-id]').count(), 0, 'census cards do not replace the loading hierarchy');
    const skeletons = page.locator('#board-stages .hierarchy-skeleton');
    assert.equal(await skeletons.count(), 3, 'a short set of row-shaped skeletons holds the board frame');
    assert.equal(await page.locator('#board-stages').getAttribute('aria-busy'), 'true');
    const skeletonY = (await skeletons.first().boundingBox()).y;
    release();
    await page.locator('[data-hierarchy-id="WR14"]').waitFor();
    assert.equal(await page.locator('#board-stages').getAttribute('aria-busy'), null);
    assert.ok(Math.abs((await page.locator('[data-hierarchy-id="WR14"]').boundingBox()).y - skeletonY) < 48, 'the first row keeps its place after loading');
    assert.deepEqual(errors, []);
  });

  for (const path of [systemPath, '/control-room?mode=live&tab=boards']) {
    test(`hierarchy taste explains completed levels without empty panels at ${width}px ${theme} ${path}`, async t => {
      const { page, errors } = await open(t, { width, path, snapshotData: hierarchy });
      await page.locator('[data-hierarchy-id="WR14"] > button').click();
      await page.locator('#hierarchy-completed > details > summary').click();
      await page.locator('[data-hierarchy-id="WR14.S1"] > button').click();
      await hierarchyEvidence(page, path === systemPath ? 'empty-page' : 'empty-room', width, theme);
      assert.match(await page.locator('#board-stages').textContent(), /All pull requests in this slice are completed\./);
      for (const id of ['board-questions', 'board-deliverables', 'board-decisions', 'board-notes']) {
        assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} has no content to show`);
      }
      assert.doesNotMatch(await page.locator('#board-stages').textContent(), /Nothing needs you/);
      await page.getByRole('button', { name: 'View completed pull requests', exact: true }).click();
      assert.equal(await page.locator('#hierarchy-completed > details').getAttribute('open'), '');
      assert.equal(await page.locator('#hierarchy-completed > details > summary').evaluate(node => node === document.activeElement), true);
      assert.equal(await page.locator('[data-hierarchy-id="WR14.S1.J1.carr#1960"]').isVisible(), true);
      assert.deepEqual(errors, []);
    });
  }
}

async function mountTestCosts(t, width = 390) {
  const { page, errors } = await open(t, { path: systemPath, width });
  await page.waitForFunction(()=>document.querySelector('#board-meta')?.dataset.readState === 'published');
  await page.evaluate(async fixture => {
    const { mountCostView } = await import('/js/progress-board-costs.js');
    const panel = document.querySelector('#board-costs'); panel.replaceChildren();
    window.testCostView = mountCostView(panel); window.testCostView.update(fixture);
  }, costs);
  return { page, panel: page.locator('#board-costs'), errors };
}

test('open cost details reconcile refreshed amounts, missing observations and removed providers', async t => {
  const { page, panel } = await mountTestCosts(t);
  await panel.getByLabel('Cost provider').selectOption('jev');
  await panel.locator('[data-day="2026-10-04"]').click();
  const updated = structuredClone(costs);
  Object.assign(updated.providers[0].daily.at(-1), { usd: 20, drivers: { review: 19, routing: 1 } });
  Object.assign(updated.providers[0], { mtd_usd: 22, projection_usd: 170.5 });
  updated.observed_at = '2026-10-05T09:00:00Z';
  await page.evaluate(next => window.testCostView.update(next), updated);
  assert.match(await panel.getByRole('dialog').textContent(), /\$20\.00.*review \$19\.00/);
  updated.providers[0].daily = [];
  updated.providers[0].state = 'unavailable';
  await page.evaluate(next => window.testCostView.update(next), updated);
  assert.match(await panel.getByRole('dialog').textContent(), /Unavailable.*incomplete coverage/);
  updated.providers.shift();
  await page.evaluate(next => window.testCostView.update(next), updated);
  assert.equal(await panel.getByRole('dialog').count(), 0);
  assert.equal(await panel.getByLabel('Cost provider').evaluate(node => node === document.activeElement), true);
});

test('cost refresh preserves focused day and dialog return focus with a fallback for a removed day', async t => {
  const { page, panel } = await mountTestCosts(t);
  const day = panel.locator('[data-day="2026-10-04"]');
  await day.focus();
  const updated = { ...costs, observed_at: '2026-10-05T09:00:00Z' };
  await page.evaluate(next => window.testCostView.update(next), updated);
  assert.equal(await day.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.evaluate(next => window.testCostView.update(next), { ...updated, observed_at: '2026-10-05T10:00:00Z' });
  await page.keyboard.press('Escape');
  assert.equal(await day.evaluate(node => node === document.activeElement), true);
  await page.evaluate(next => window.testCostView.update(next), { ...updated, through: '2026-10-03' });
  assert.equal(await panel.getByLabel('Cost month').evaluate(node => node === document.activeElement), true);
});

for (const width of [320, 390]) test(`all cost days have an equivalent phone touch control at ${width}px`, async t => {
  const { page, panel } = await mountTestCosts(t, width);
  await panel.getByLabel('Cost month').selectOption('2026-09');
  const selector = panel.getByLabel('Cost day');
  assert.equal(await selector.count(), 1);
  assert.equal(await selector.locator('option').count(), 30);
  const button = panel.getByRole('button', { name: 'Open day details' });
  const boxes = await Promise.all([selector.boundingBox(), button.boundingBox()]);
  for (const box of boxes) assert.ok(box.width >= 44 && box.height >= 44, JSON.stringify(box));
  assert.ok(boxes[0].x + boxes[0].width <= boxes[1].x || boxes[0].y + boxes[0].height <= boxes[1].y);
  await selector.selectOption('2026-09-01'); await button.click();
  assert.match(await panel.getByRole('dialog').textContent(), /2026-09-01.*Unavailable/s);
  await page.keyboard.press('Escape');
  assert.equal(await button.evaluate(node => node === document.activeElement), true);
  await selector.selectOption('2026-09-20'); await button.click();
  assert.match(await panel.getByRole('dialog').textContent(), /review \$50\.00/);
  assert.equal(await panel.evaluate(node => node.scrollWidth <= node.clientWidth), true);
});

test('cost panel has day popup, month history, provider selection and measured reduced motion on mobile', async t => {
  const { page, errors } = await open(t, { path: systemPath, costData: costs });
  const panel = page.locator('#board-costs');
  await panel.waitFor();
  assert.match(await panel.textContent(), /Coverage incomplete/);
  assert.equal(await panel.locator('.cost-state').evaluate(node => getComputedStyle(node, '::before').animationName), 'none');
  await panel.getByLabel('Cost provider').selectOption('jev');
  assert.match(await panel.textContent(), /Projected month\$93\.00/);
  if (process.env.COST_EVIDENCE_DIR) {
    await mkdir(process.env.COST_EVIDENCE_DIR, { recursive: true });
    await page.clock.runFor(450);
    await panel.screenshot({ path: `${process.env.COST_EVIDENCE_DIR}/cost-panel-mobile.png` });
    const before = await open(t, { path: systemPath });
    await before.page.locator('#board-stages').waitFor();
    await before.page.screenshot({ path: `${process.env.COST_EVIDENCE_DIR}/board-without-costs.png` });
  }
  await panel.locator('[data-day="2026-10-04"]').click();
  await panel.getByRole('dialog').waitFor();
  assert.match(await panel.getByRole('dialog').textContent(), /review \$9\.00/);
  await panel.getByRole('button', { name: 'Close' }).click();
  await panel.getByLabel('Cost month').selectOption('2026-09');
  assert.equal(await panel.locator('[data-day]').count(), 30);
  assert.match(await panel.textContent(), /Monthly spend\$50\.00/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await panel.locator('.cost-state').evaluate(node => getComputedStyle(node, '::before').animationName), 'none');
  assert.equal(await panel.locator('.cost-bar').first().evaluate(node => getComputedStyle(node).transitionDuration), '0s');
  assert.equal(await panel.evaluate(node => node.scrollWidth <= node.clientWidth), true);
  if (process.env.COST_EVIDENCE_DIR) await panel.screenshot({ path: `${process.env.COST_EVIDENCE_DIR}/cost-panel-history-reduced-motion.png` });
  assert.deepEqual(errors, []);
});

test('independent census diagram uses the same stage colors as the published board legend', async t => {
  const { page, errors } = await open(t, { path: systemPath, rows: [workRow('open')] });
  await page.locator('#system-work-flow .flow-stage').first().waitFor();
  for (const stage of STAGES) {
    // Stage colours are token roles, so the expected paint is whatever that role resolves to here.
    const expected = await page.evaluate(color => { const probe = document.body.appendChild(document.createElement('i')); probe.style.color = color; const value = getComputedStyle(probe).color; probe.remove(); return value; }, stage.color);
    assert.notEqual(expected, 'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator(`#system-work-flow [data-stage="${stage.id}"] .stage-well`).evaluate(node => getComputedStyle(node).stroke), expected);
  }
  assert.equal(new Set(await Promise.all(STAGES.map(stage => page.locator(`#system-work-flow [data-stage="${stage.id}"] .stage-well`).evaluate(node => getComputedStyle(node).stroke)))).size, STAGES.length,
    'each stage keeps its own colour');
  assert.deepEqual(errors, []);
});
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
    await page.locator('#board-stages [data-card-id="build"]').waitFor();
    await panelTasks(page, ['open']);
    const original = page.url();
    active = true;
    const success = order === 'success-first'
      ? page.waitForResponse(response => response.url().endsWith('/mcp') && response.status() === 200) : null;
    await page.clock.runFor(60_000);
    if (order === 'success-first') await success;
    else await page.waitForURL('**/public-shell/session-ended.html*');
    release();
    await page.waitForURL('**/public-shell/session-ended.html*');
    assert.equal(await page.locator('#board-stages [data-card-id], #board-completed .completed-card, #system-work-flow [data-task-id], .work-card').count(), 0);
    assert.doesNotMatch(await page.locator('body').textContent(), /Synthetic build/);
    active = false;
    await page.goto(original);
    await page.locator('#board-stages [data-card-id="build"]').waitFor();
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
  await page.clock.runFor(60_000);
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
  await page.locator('#board-stages [data-card-id="build"]').waitFor();
  await panelTasks(page, ['open']);
  active = true;
  await page.clock.runFor(60_000);
  await page.locator(failed === 'unfinished-work' ? '#system-work-error' : '#board-error').waitFor();
  assert.equal(await page.locator('#board-stages [data-card-id="build"]').count(), 1);
  await panelTasks(page, ['open']);
  assert.equal(await page.locator('#board-sign-in').isVisible(), false);
  active = false;
  await page.clock.runFor(60_000);
  await page.waitForFunction(() => document.querySelector('#board-error').hidden && document.querySelector('#system-work-error').hidden);
  assert.deepEqual(errors, []);
});

for (const empty of [false, true]) test(`automatic refresh keeps keyboard position when a census task is removed (${empty ? 'empty' : 'remaining'} result)`, async t => {
  const { page, setRows, errors } = await open(t, { path: systemPath, rows: [workRow('remove'), workRow('keep')] });
  await panelTasks(page, ['remove', 'keep']);
  await page.locator('#system-work-flow [data-task-id="loop:remove"]').focus();
  setRows(empty ? [] : [workRow('keep')]);
  await page.clock.runFor(60_000);
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
    await page.clock.runFor(60_000);
    await page.waitForFunction(() => document.querySelector('#board-meta').textContent.includes('Version 2'));
    if (change === 'updated') {
      assert.match(await card.textContent(), /Updated summary/);
      assert.equal(await card.evaluate(node => node === document.activeElement), true);
      assert.equal(await card.evaluate(node => node === window.focusedLiveCard), true, 'retain the same card by task identity');
      await page.keyboard.press('Enter');
      await page.waitForURL(url => url.pathname === '/control-room/progress/work'
        && url.searchParams.get('board') === 'demo-project' && url.searchParams.get('task') === 'released'
        && url.searchParams.get('work_request') === 'WR-102');
    } else {
      assert.equal(await page.locator('.completed-card').count(), change === 'removed' ? 1 : 0);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'completed-title');
    }
    assert.deepEqual(errors, []);
  });
}

for (const width of [390, 1440]) {
  for (const change of ['unchanged', 'updated', 'unblocked', 'removed', 'empty']) test(`Blocked work keeps keyboard position during automatic refresh (${width}px, ${change})`, async t => {
    const blocked = { title: 'Synthetic blocked task', status: 'blocked', stage: 'review',
      blocked_reason: 'Original reason', next_action: 'Original next action', work_request: 'WR-101' };
    let tasks = { keep: { ...blocked, title: 'Other blocked task' }, blocked };
    let version = 1;
    const { page, errors } = await open(t, { width, path: '/control-room/progress/board/demo-project', control: async (route, rpc) => {
      if (rpc.name !== 'read-progress-board') return false;
      const payload = { snapshot: { board_id: 'demo-project', version,
        updated_at: '2026-10-02T08:00:00Z', snapshot_json: { title: 'Demo project', tasks } }, questions: [] };
      await route.fulfill({ json: { result: { content: [{ text: JSON.stringify(payload) }] } } });
      return true;
    } });
    const card = page.locator('#board-blocked [data-card-id="blocked"]');
    await card.waitFor();
    await card.focus();
    await card.evaluate(node => { window.focusedBlockedCard = node; });
    if (change === 'updated') tasks = { blocked: { ...blocked, title: 'Updated blocked task', stage: 'ci',
      blocked_reason: 'Updated reason', next_action: 'Updated next action', work_request: 'WR-102' }, keep: tasks.keep };
    else if (change === 'unblocked') tasks = { keep: tasks.keep, blocked: { title: blocked.title, status: 'running', stage: 'build', updated_at: new Date().toISOString() } };
    else if (change === 'removed') tasks = { keep: tasks.keep };
    else if (change === 'empty') tasks = {};
    if (change !== 'unchanged') version++;
    const read = page.waitForResponse(response => response.url().endsWith('/mcp')
      && response.request().postDataJSON().params.name === 'read-progress-board');
    await page.clock.runFor(60_000);
    await (await read).finished();
    await page.waitForLoadState('networkidle');
    if (change === 'unchanged' || change === 'updated') {
      assert.equal(await card.evaluate(node => node === document.activeElement), true, 'keep the focused blocked task');
      assert.equal(await card.evaluate(node => node === window.focusedBlockedCard), true, 'retain the same card by task identity');
      assert.equal(await page.locator('#blocked-count').textContent(), '2 BLOCKED');
      if (change === 'updated') {
        assert.match(await card.textContent(), /Updated blocked task.*Why: Updated reason.*Next: Updated next action/);
        assert.equal(await card.evaluate(node => node.style.getPropertyValue('--stage-accent')), STAGES.find(stage => stage.id === 'ci').color);
        assert.equal(await page.locator('#board-blocked .blocked-card').first().getAttribute('data-card-id'), 'blocked');
      }
      await page.keyboard.press('Enter');
      await page.waitForURL(url => url.pathname === '/control-room/progress/work'
        && url.searchParams.get('board') === 'demo-project' && url.searchParams.get('task') === 'blocked'
        && url.searchParams.get('work_request') === (change === 'updated' ? 'WR-102' : 'WR-101'));
    } else {
      assert.equal(await card.count(), 0);
      const count = change === 'empty' ? 0 : 1;
      assert.equal(await page.locator('#board-blocked .blocked-card').count(), count);
      assert.equal(await page.locator('#blocked-count').textContent(), `${count} BLOCKED`);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'blocked-title');
      if (change === 'unblocked') assert.equal(await page.locator('#board-stages [data-card-id="blocked"]').count(), 1);
    }
    assert.deepEqual(errors, []);
  });
}


for (const width of [390, 1440]) test(`Work Request drill-down works in the rendered page at ${width}px`, async t => {
  const { page, errors } = await open(t, {width, path:'/control-room/progress/board/carr-v5', snapshotData:hierarchy});
  const card = id => page.locator(`[data-hierarchy-id="${id}"]`);
  await card('WR14').getByRole('button', {name:'Board cleanup'}).click();
  await card('WR14.S2').getByRole('button', {name:'Board navigation'}).click();
  await page.locator('#board-stages .column[data-stage="review"]').waitFor();
  assert.equal(await card('WR14.S1.J1.carr#1960').count(), 0);
  assert.equal(await card('WR14.S2.J1.app#316').count(), 1);
  assert.equal(new URL(page.url()).searchParams.get('card'), 'WR14.S2');
  await page.locator('#hierarchy-back').click();
  assert.equal(new URL(page.url()).searchParams.get('card'), 'WR14');
  const completed = page.locator('#hierarchy-completed > details');
  assert.equal(await completed.getAttribute('open'), null);
  await completed.locator('summary').first().click();
  await card('WR14.S1').getByRole('button', {name:'Board grouping'}).click();
  await page.locator('#hierarchy-completed > details > summary').click();
  await card('WR14.S1.J1.carr#1960').locator('summary').click();
  await card('WR14.S1.J1.carr#1960').getByText('merge sha · ' + 'a'.repeat(40)).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  await mkdir('test-artifacts/progress-hierarchy', {recursive:true});
  await page.screenshot({path:`test-artifacts/progress-hierarchy/${width}.png`, fullPage:true});
});


for (const width of [320, 390, 1280]) for (const theme of ['light', 'dark'])
  test(`living queue preserves focus, scroll and expanded detail at ${width}px in ${theme}`, async t => {
    const { page, errors, setSnapshot } = await open(t, { width, timezoneId: 'America/Chicago',
      path: '/control-room/progress/board/carr-v5?card=WR14.S1.J1', snapshotData: structuredClone(workQueue) });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const job = page.locator('[data-queue-id="WR14.S1.J1"]');
    await job.locator('> summary').waitFor();
    assert.equal(await job.getAttribute('open'), '');
    for (const id of ['board-questions', 'board-blocked', 'board-ledger', 'board-deliverables', 'board-decisions', 'board-notes'])
      assert.equal(await page.locator(`#${id}`).evaluate(el => el.closest('.panel').hidden), true, `${id} stays hidden on the queue`);
    const eventAt = workQueue.work_queue.history.find(event => event.card_id === 'WR14.S1.J1').at;
    const eventText = await job.locator('.queue-log li').first().textContent();
    assert.equal(eventText.startsWith(eventAt), false, 'event history does not expose the raw timestamp');
    assert.match(eventText, /Oct 19, \d{1,2}:00 AM/, 'event history uses a compact local timestamp');
    await job.locator('> summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await job.getAttribute('open'), null, 'keyboard collapses job');
    await page.keyboard.press('Enter');
    assert.equal(await job.getAttribute('open'), '', 'keyboard expands job');
    await job.locator('> summary').scrollIntoViewIfNeeded();
    const scroll = await job.evaluate(node => node.closest('.app-layout-center').scrollTop);
    assert.ok(scroll > 0, 'the job is scrolled into the board viewport');
    const changed = structuredClone(workQueue);
    changed.work_queue.board.order.reverse();
    changed.work_queue.revision++;
    setSnapshot(changed);
    await page.clock.runFor(60_300);
    await page.locator('[data-queue-root] > section:first-child[data-queue-id="WR14"]').waitFor({ timeout: 5000 });
    assert.deepEqual(await page.locator('[data-queue-root] > section').evaluateAll(cards => cards.map(c => c.dataset.queueId)), ['WR14','WR20']);
    assert.equal(await page.evaluate(() => document.activeElement.parentElement.dataset.queueId), 'WR14.S1.J1');
    assert.equal(await job.evaluate(node => node.closest('.app-layout-center').scrollTop), scroll);
    assert.equal(await job.getAttribute('open'), '');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.match(await job.textContent(), /gpt-6.1-sol/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    changed.work_queue.board.order.reverse(); changed.work_queue.revision++;
    setSnapshot(structuredClone(changed));
    await page.clock.runFor(60_300);
    await page.locator('[data-queue-root] > section:first-child[data-queue-id="WR20"]').waitFor({ timeout: 5000 });
    assert.equal(await page.locator('[data-queue-root]').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    assert.deepEqual(errors, []);
    await page.evaluate(axe.source);
    assert.deepEqual(await page.evaluate(async () => (await axe.run('#board-stages')).violations.map(v => v.id)), []);
    await mkdir('test-artifacts/work-queue', { recursive: true });
    await page.screenshot({ path: `test-artifacts/work-queue/${width}-${theme}.png`, fullPage: true });
    if (width === 390 && theme === 'light') {
      await mkdir('test/evidence/work-queue', { recursive: true });
      await job.locator('.queue-log').evaluate(el => { el.open = true; });
      await page.screenshot({ path: 'test/evidence/work-queue/followup-390.png', fullPage: true });
    }
  });

test('an unreviewed fixture preview renders queue details without calling the live board', async t => {
  const { page, calls, errors } = await open(t, {path:'/control-room/progress/board/carr-v5?mode=fixture&card=WR14.S1.J1', boardRead:'failed'});
  await page.locator('[data-queue-id="WR14.S1.J1"][open]').waitFor({ timeout: 3000 });
  assert.equal(calls.filter(call => call.name === 'read-progress-board').length, 0);
  assert.match(await page.locator('#board-stages').textContent(), /Demo queue ordering/);
  assert.deepEqual(errors, []);
});

for (const status of [401, 403]) test(`denied hierarchy read ${status} stays empty through browser Back and recovers unchanged data`, async t => {
  let denied = false;
  const {page, errors} = await open(t, {path:systemPath, snapshotData:hierarchy, control:async(route,rpc)=>{
    if (!denied || rpc.name !== 'read-progress-board') return false;
    await route.fulfill({status, body:'{}'});
    return true;
  }});
  const original = page.url();
  const cards = page.locator('#board-stages [data-hierarchy-id]');
  await page.locator('[data-hierarchy-id="WR14"] > button').click();
  assert.equal(await cards.count(), 2);
  denied = true;
  await page.clock.runFor(60_000);
  await page.waitForURL('**/public-shell/session-ended.html*');
  assert.equal(await cards.count(), 0);
  await page.goBack();
  await page.waitForURL('**/public-shell/session-ended.html*');
  assert.equal(await cards.count(), 0);
  denied = false;
  await page.goto(original);
  await page.locator('[data-hierarchy-id="WR14"]').waitFor();
  assert.equal(await cards.count(), 1);

  assert.deepEqual(errors, []);
});

for (const status of [401, 403]) test(`denied queue read ${status} recovers the same queue after browser Back`, async t => {
  let denied = false;
  const {page, errors} = await open(t, {path:systemPath, snapshotData:workQueue, control:async(route,rpc)=>{
    if (!denied || rpc.name !== 'read-progress-board') return false;
    await route.fulfill({status, body:'{}'});
    return true;
  }});
  const cards = page.locator('#board-stages [data-queue-id]');
  await cards.first().waitFor({state:'attached'});
  const count = await cards.count();
  await page.evaluate(()=>history.pushState({},'',location.pathname+'?card=WR14.S1.J1'));
  const original = page.url();
  denied = true;
  await page.clock.runFor(60_000);
  await page.waitForURL('**/public-shell/session-ended.html*');
  assert.equal(await cards.count(), 0);
  await page.goBack();
  await page.waitForURL('**/public-shell/session-ended.html*');
  assert.equal(await cards.count(), 0);
  denied = false;
  await page.goto(original);
  await page.waitForLoadState('networkidle');
  assert.equal(await cards.count(), count);
  assert.deepEqual(errors, []);
});

test('leaving a job through browser history closes its actual detail dialog', async t => {
  const { page, errors } = await open(t, {path:systemPath, snapshotData:hierarchy, autoMount:false});
  await page.evaluate(async ({fixture, html}) => {
    const {mountBoard} = await import('/js/progress-board.js');
    const {mountJobDetail} = await import('/js/job-detail.js');
    const template = new DOMParser().parseFromString(html, 'text/html');
    document.body.append(template.getElementById('jobDialog'));
    const client = {readProgressBoard:async()=>({snapshot:{version:1,snapshot_json:fixture}})};
    const detail = mountJobDetail({client, document});
    window.historyBoard = mountBoard({window, client, openTask:task=>detail.open(task), closeTask:()=>detail.clear()});
    await window.historyBoard.refresh(true);
  }, {fixture:hierarchy, html:await readFile(new URL('../control-room.html', import.meta.url), 'utf8')});
  const card = id => page.locator(`[data-hierarchy-id="${id}"] > button`);
  await card('WR14').click();
  await card('WR14.S2').click();
  await card('WR14.S2.J1.app#316').click();
  const dialog = page.locator('#jobDialog');
  await dialog.waitFor({state:'visible'});
  assert.equal(await page.locator('#jobTitle').textContent(), 'Board navigation');
  await page.goBack();
  assert.equal(new URL(page.url()).searchParams.get('card'), 'WR14.S2');
  assert.equal(await dialog.isVisible(), false);
  await page.goForward();
  await dialog.waitFor({state:'visible'});
  await page.goBack();
  await page.goBack();
  assert.equal(new URL(page.url()).searchParams.get('card'), 'WR14');
  assert.equal(await dialog.isVisible(), false);
  await page.goBack();
  assert.equal(new URL(page.url()).searchParams.get('card'), null);
  assert.equal(await dialog.isVisible(), false);
  assert.deepEqual(errors, []);
});

for (const width of [390, 1280]) test(`queue polling retains the open event log and keyboard focus at ${width}px`, async t => {
  const {page, calls, errors, setSnapshot} = await open(t, {width, height:844,
    path:'/control-room/progress/board/carr-v5?card=WR14.S1.J1', snapshotData:structuredClone(workQueue)});
  const job = page.locator('[data-queue-id="WR14.S1.J1"]');
  const log = job.locator('.queue-log');
  await log.locator('summary').click();
  await log.locator('summary').focus();
  const reads = calls.filter(c => c.name === 'read-progress-board').length;
  const changed = structuredClone(workQueue);
  changed.work_queue.board.nodes['WR14.S1.J1'].total_time_s += 2;
  changed.work_queue.revision++;
  setSnapshot(changed);
  await page.clock.runFor(60_300);
  await page.waitForFunction(() => document.querySelector('.queue-status').textContent.includes('revision 11'));
  assert.ok(calls.filter(c => c.name === 'read-progress-board').length > reads, 'the actual board poll read the changed snapshot');
  assert.equal(await log.getAttribute('open'), '', 'manual event-log disclosure survives polling');
  assert.equal(await log.locator('summary').evaluate(el => document.activeElement === el), true, 'focus remains on the event-log summary');
  assert.deepEqual(errors, []);
  await mkdir('test/evidence/work-queue', {recursive:true});
  await log.locator('summary').scrollIntoViewIfNeeded();
  await page.screenshot({path:`test/evidence/work-queue/poll-${width}.png`});
  await job.locator('.queue-execution > summary').click();
  for (const control of [job.locator('.queue-execution > summary'), job.locator('[data-pr]')]) {
    await control.focus();
    changed.work_queue.revision++;
    changed.work_queue.board.nodes['WR14.S1.J1'].total_time_s += 2;
    setSnapshot(structuredClone(changed));
    await page.clock.runFor(60_300);
    await page.waitForFunction(revision => document.querySelector('.queue-status').textContent.includes(`revision ${revision}`), changed.work_queue.revision);
    assert.equal(await control.evaluate(el => document.activeElement === el), true, 'the same control keeps focus after a changed-card poll');
    assert.equal(await job.locator('.queue-execution').getAttribute('open'), '');
    assert.equal(await log.getAttribute('open'), '');
  }

});

for (const width of [390, 1280]) test(`queue first view shows producer-ordered job titles and states at ${width}px`, async t => {
  const {page, errors} = await open(t, {width, height:844, path:'/control-room/progress/board/carr-v5', snapshotData:structuredClone(workQueue)});
  await page.locator('[data-queue-id="WR20.S1.J1"] > summary').waitFor({state:'attached'});
  assert.equal(await page.locator('#board-rail').isVisible(), false, 'the pipeline rail does not occupy queue space');
  assert.equal(await page.locator('#board-filters').isVisible(), false, 'pipeline filters do not occupy queue space');
  assert.deepEqual(await page.locator('.queue-job').evaluateAll(jobs => jobs.map(el => el.dataset.queueId)), ['WR20.S1.J1','WR14.S2.J1','WR14.S1.J1']);
  for (const [id, title, state] of [['WR20.S1.J1','Demo release checks','queued'],['WR14.S2.J1','Demo board details','queued'],['WR14.S1.J1','Demo queue ordering','review']]) {
    const summary = page.locator(`[data-queue-id="${id}"] > summary`);
    assert.match(await summary.textContent(), new RegExp(title));
    assert.match(await summary.locator('.queue-state').textContent(), new RegExp(state));
    assert.equal(await summary.isVisible(), true, `${title} is visible without expanding ancestors`);
    const box = await summary.boundingBox();
    const viewport = await summary.evaluate(el => { const rect = el.closest('.app-layout-center').getBoundingClientRect(); return {top:rect.top,bottom:rect.bottom}; });
    assert.ok(box.y >= viewport.top && box.y + box.height <= viewport.bottom, `${title} and its state fit in the first viewport`);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  await mkdir('test/evidence/work-queue', {recursive:true});
  await page.screenshot({path:`test/evidence/work-queue/queue-${width}.png`});
});

for (const width of [390, 1280]) test(`expanded queue detail leads with findings and PR/log actions at ${width}px`, async t => {
  const {page, errors} = await open(t, {width, height:844,
    path:'/control-room/progress/board/carr-v5', snapshotData:structuredClone(workQueue)});
  const job = page.locator('[data-queue-id="WR14.S1.J1"]');
  await job.locator('> summary').click();
  const logLink = job.locator('[data-job-log]');
  const box = await logLink.boundingBox();
  const viewport = await logLink.evaluate(el => { const rect = el.closest('.app-layout-center').getBoundingClientRect(); return {top:rect.top,bottom:rect.bottom}; });
  assert.ok(box && box.y >= viewport.top && box.y + box.height <= viewport.bottom, 'the log action sits in the first viewport of the expanded detail');
  assert.equal(await job.locator('[data-pr]').isVisible(), true);
  assert.match(await job.locator('.queue-findings').textContent(), /P2.*Show unknown timing.*Open/s);
  assert.doesNotMatch(await job.locator('.queue-findings').textContent(), /Preserve keyboard focus/);
  assert.equal(await job.getByText('gpt-6.1-sol', {exact:true}).isVisible(), false, 'execution metadata starts collapsed');
  assert.deepEqual(errors, []);
  await mkdir('test/evidence/work-queue', {recursive:true});
  await page.screenshot({path:`test/evidence/work-queue/detail-${width}.png`});
  await job.locator('.queue-execution > summary').click();
  assert.equal(await job.getByText('gpt-6.1-sol', {exact:true}).isVisible(), true);
});


for (const width of [390,1280]) for (const theme of ['light','dark'])
  test(`orchestrator published queue observations update in place at ${width}px ${theme}`, async t => {
    const {page,errors,setSnapshot}=await open(t,{width,timezoneId:'America/Chicago',
      path:'/control-room/progress/board/orchestrator',snapshotData:orchestratorSequence[0].snapshot.snapshot_json,
      assetRoot:process.env.ORCHESTRATOR_BUILT_ROOT ? new URL(`file://${process.env.ORCHESTRATOR_BUILT_ROOT}/`) : undefined});
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const first=page.locator('[data-orchestrator-card]').first();await first.waitFor();
    if (width === 1280) {
      const position = await page.evaluate(() => ({main:document.querySelector('.progress-main').getBoundingClientRect().left, pipeline:document.querySelector('.pipeline-panel').getBoundingClientRect().left}));
      assert.ok(Math.abs(position.main-position.pipeline) < 2, 'a hidden directory reserves no left column');
    }
    const box=await first.locator('.orchestrator-progress').boundingBox();
    if(width===390) assert.ok(box && box.y+box.height<820,'first title, status and progress fit above phone navigation');
    await mkdir('test-artifacts/orchestrator',{recursive:true});
    await page.screenshot({path:`test-artifacts/orchestrator/initial-${width}-${theme}.png`});
    const olderPage='orchestrator-page-'+'a'.repeat(64);
    let pageUnavailable=true;
    await page.route('**/mcp', async route => {
      const rpc=route.request().postDataJSON().params;
      if(rpc?.name!=='read-progress-board' || rpc.arguments.board_id!==olderPage) return route.fallback();
      if(pageUnavailable) return route.fulfill({status:503,contentType:'application/json',body:'{}'});
      return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{text:JSON.stringify({snapshot:{version:1,snapshot_json:{cards:[{
        id:'older-release',title:'Older unresolved release',state:'merged',owner:'cx-app2',prs:[],changed_at:'2026-01-01T00:00:00Z'
      }]}}})}]}})});
    });
    await page.locator('[data-orchestrator-card="queue:search"]').waitFor();
    await page.evaluate(()=>{
      window.__orchestratorCard=document.querySelector('[data-orchestrator-card="queue:search"]');
      window.__orchestratorLink=window.__orchestratorCard.querySelector('a');
      window.__orchestratorLink.focus({preventScroll:true});
      window.__orchestratorCard.querySelector('details').open=true;
    });
    for(const [index,state] of [[1,'working'],[2,'review'],[3,'fixing'],[4,'merging'],[5,'merged'],[6,'live']]) {
      setSnapshot(orchestratorSequence[index].snapshot.snapshot_json);
      await page.clock.runFor(60_100);
      await page.locator(`[data-orchestrator-stage="${state}"] [data-orchestrator-card="queue:search"]`).waitFor();
      assert.equal(await page.evaluate(()=>document.querySelector('[data-orchestrator-card="queue:search"]')===window.__orchestratorCard),true);
      assert.equal(await page.evaluate(()=>document.activeElement===window.__orchestratorLink),true);
      assert.equal(await page.locator('[data-orchestrator-card="queue:search"] details').getAttribute('open'),'');
    }
    setSnapshot(orchestratorSequence[7].snapshot.snapshot_json);
    await page.clock.runFor(60_100);
    await page.locator('[data-orchestrator-status]').filter({hasText:'Queue observation unavailable or stale'}).waitFor();
    assert.equal(await page.locator('[data-orchestrator-stage="live"] [data-orchestrator-card="queue:search"]').count(),1);
    assert.equal(await page.locator('[data-orchestrator-stage]').count(),8);
    const paged=structuredClone(orchestratorSequence[7].snapshot.snapshot_json);
    paged.orchestrator.total_cards=paged.orchestrator.cards.length+1;
    paged.orchestrator.pages=[{board_id:olderPage,version:1,count:1}];
    setSnapshot(paged);await page.clock.runFor(60_100);
    await page.locator('[data-orchestrator-more]').click();
    await page.locator('[data-orchestrator-pagination]').filter({hasText:'unavailable'}).waitFor();
    assert.equal(await page.locator('[data-orchestrator-card="queue:search"]').count(),1);
    pageUnavailable=false;await page.locator('[data-orchestrator-more]').click();
    await page.locator('[data-orchestrator-card="older-release"]').waitFor();
    assert.match(await page.locator('[data-orchestrator-card="older-release"]').textContent(),/Merged \/ awaiting release/);
    const older=page.locator('[data-orchestrator-card="older-release"]');
    await older.locator('details').evaluate(el=>el.open=true);
    await older.locator('summary').focus();
    const scroll=await older.evaluate(el=>el.closest('.app-layout-center').scrollTop);
    const changed=structuredClone(paged);changed.orchestrator.observed_at='2026-10-21T20:00:00Z';
    changed.orchestrator.cards[0].state='fixing';setSnapshot(changed);await page.clock.runFor(60_100);
    assert.equal(await older.locator('details').getAttribute('open'),'');
    assert.equal(await older.locator('summary').evaluate(el=>el===document.activeElement),true);
    assert.equal(await older.evaluate(el=>el.closest('.app-layout-center').scrollTop),scroll);
    setSnapshot({tasks:{}});await page.clock.runFor(60_100);
    setSnapshot(changed);await page.clock.runFor(180_300);
    assert.equal(await older.count(),1);


    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const targets=await page.locator('.orchestrator-count,.orchestrator-links a,.orchestrator-detail summary').evaluateAll(nodes=>nodes.map(el=>el.getBoundingClientRect().height));
    assert.ok(targets.every(height=>height>=44));
    const violations=await page.evaluate(async source=>{eval(source);return (await axe.run(document.querySelector('#board-stages'))).violations;},axe.source);
    assert.deepEqual(violations.map(v=>v.id),[]);
    assert.deepEqual(errors,[]);
    await mkdir('test-artifacts/orchestrator',{recursive:true});
    await page.screenshot({path:`test-artifacts/orchestrator/${width}-${theme}.png`,fullPage:true});
  });


test('session invalidation disposes board callbacks before its document is cleared', async t => {
  const {page, errors} = await open(t, {path:systemPath, snapshotData:workQueue, autoMount:false});
  const result = await page.evaluate(async fixture => {
    const {mountBoard} = await import('/js/progress-board.js');
    let reads = 0;
    const client = {readProgressBoard:async()=>{reads++; return {snapshot:{version:1,snapshot_json:fixture}};}};
    const board = mountBoard({window, client});
    await board.refresh(true);
    window.dispatchEvent(new Event('doctorcre-session-invalidated'));
    document.body.replaceChildren();
    await board.refresh(true);
    board.tick();
    return {reads, text:document.body.textContent};
  }, workQueue);
  assert.deepEqual(result, {reads:1, text:''});
  assert.deepEqual(errors, []);
});
