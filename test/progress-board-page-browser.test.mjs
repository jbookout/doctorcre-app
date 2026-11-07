import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { pausedClock } from './browser-harness.mjs';
import axe from 'axe-core';
import { STAGES } from '../js/progress-board-model.js';
import costs from './fixtures/progress-board-costs.json' with { type: 'json' };
import hierarchy from './fixtures/progress-board-hierarchy.json' with { type: 'json' };
import { QUEUE_STAGES } from '../js/work-queue-board-model.js';

import { open, queueRead, queueJob, systemPath, projectPath } from './progress-board-page-fixture.mjs';
for (const unfinished of [false, true]) test(`board tile opens its page and published task flow with unfinishedWork ${unfinished ? 'available' : 'unavailable'}`, async t => {
  const snapshot = Promise.withResolvers();
  t.after(() => snapshot.resolve());
  const { page, context, errors } = await open(t, { unfinished, control: async (_route, rpc) => {
    if (rpc.name === 'read-progress-board') await snapshot.promise;
  } });
  await page.locator('[data-board-id="carr-v5"]').waitFor({ state: 'attached' });
  await page.getByText('Published boards', { exact: true }).click();
  const link = page.locator('[data-board-id="carr-v5"]');
  const target = await link.getAttribute('target');
  const opened = target === '_blank' ? context.waitForEvent('page') : null;
  await link.click();
  const board = opened ? await opened : page;
  await board.locator('#board-stages [data-card-id="WR14.S1.J1"]').waitFor();
  snapshot.resolve();
  await board.locator('#board-meta[data-read-state="published"]').waitFor({ state: 'attached' });
  assert.equal(await board.locator('#board-title').textContent(), 'System Job Board');
  assert.equal(new URL(board.url()).pathname, '/control-room/progress/board/carr-v5');
  assert.deepEqual(await board.locator('#board-stages .column').evaluateAll(columns => columns.map(column => column.dataset.stage)),
    QUEUE_STAGES.map(stage => stage.id), 'every stage renders, empty or not');
  assert.equal(await board.locator('.directory-panel').isVisible(), true, 'the canonical board retains its project selector');
  if (!unfinished) {
    assert.match(await board.locator('#system-work-error').textContent(), /System work updates unavailable/);
    assert.equal(await board.locator('#system-work-retry').isVisible(), true);
  }
  assert.deepEqual(errors, []);
});

for (const id of ['carr-v5', 'demo-project']) test(`legacy ${id} query redirects to the work queue`, async t => {
  const { page, errors } = await open(t, { path: `/control-room/progress?board=${id}&view=flow` });
  await page.locator('#board-stages [data-card-id="WR14.S1.J1"]').waitFor();
  assert.equal(new URL(page.url()).pathname, '/control-room/progress/board/carr-v5');
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
async function hierarchyEvidence(page, state, width, theme) {
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  if (!process.env.HIERARCHY_EVIDENCE_DIR) return;
  await mkdir(process.env.HIERARCHY_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.HIERARCHY_EVIDENCE_DIR}/${state}-${width}-${theme}.png`, fullPage: true });
}

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
  test(`hierarchy keeps one heading when shell arrives after board at ${width}px ${theme}`, async t => {
    const { page, errors } = await open(t, { width, path: projectPath, snapshotData: hierarchy,
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
    const { page, errors } = await open(t, { width, path: projectPath, snapshotData: hierarchy });
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

  for (const path of [projectPath]) {
    test(`hierarchy taste explains completed levels without empty panels at ${width}px ${theme} ${path}`, async t => {
      const { page, errors } = await open(t, { width, path, snapshotData: hierarchy });
      await page.locator('[data-hierarchy-id="WR14"] > button').click();
      await page.locator('#hierarchy-completed > details > summary').click();
      await page.locator('[data-hierarchy-id="WR14.S1"] > button').click();
      await hierarchyEvidence(page, 'empty-page', width, theme);
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

// The system board's census and snapshot have no clock of their own; the Refresh control reads them.
// A programmatic click keeps keyboard focus where the person left it.
const manualRefresh = page => page.evaluate(() => document.getElementById('board-retry').click());

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
    await page.locator('#board-stages [data-card-id="WR14.S1.J1"]').waitFor();
    await panelTasks(page, ['open']);
    const original = page.url();
    active = true;
    const success = order === 'success-first'
      ? page.waitForResponse(response => response.url().endsWith('/mcp') && response.status() === 200) : null;
    await manualRefresh(page);
    if (order === 'success-first') await success;
    else await page.waitForURL('**/public-shell/session-ended.html*');
    release();
    await page.waitForURL('**/public-shell/session-ended.html*');
    assert.equal(await page.locator('#board-stages [data-card-id], #board-completed .completed-card, #system-work-flow [data-task-id], .work-card').count(), 0);
    assert.doesNotMatch(await page.locator('body').textContent(), /Synthetic queue work/);
    active = false;
    await page.goto(original);
    await page.locator('#board-stages [data-card-id="WR14.S1.J1"]').waitFor();
    await panelTasks(page, ['open']);
    assert.equal(await page.locator('#board-sign-in').isVisible(), false);
    assert.deepEqual(errors, []);
  });
}

test('Library pipeline membership and count follow mode, filters, and manual refresh', async t => {
  const { page, setRows, errors } = await open(t, { path: systemPath, rows: [workRow('open'), workRow('done', true)] });
  await panelTasks(page, ['open', 'done']);
  await page.locator('#live-library').click();
  await page.locator('#system-work-cards [data-work-id="done"]').waitFor();
  await panelTasks(page, ['done']);
  setRows([workRow('open'), ...Array.from({ length: 12 }, (_, i) => workRow(`done-${i}`, true))]);
  await manualRefresh(page);
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
  await page.locator('#board-stages [data-card-id="WR14.S1.J1"]').waitFor();
  await panelTasks(page, ['open']);
  active = true;
  await manualRefresh(page);
  await page.locator(failed === 'unfinished-work' ? '#system-work-error' : '#board-error').waitFor();
  assert.equal(await page.locator('#board-stages [data-card-id="WR14.S1.J1"]').count(), 1);
  await panelTasks(page, ['open']);
  assert.equal(await page.locator('#board-sign-in').isVisible(), false);
  active = false;
  await manualRefresh(page);
  await page.waitForFunction(() => document.querySelector('#board-error').hidden && document.querySelector('#system-work-error').hidden);
  assert.deepEqual(errors, []);
});

for (const empty of [false, true]) test(`a refresh keeps keyboard position when a census task is removed (${empty ? 'empty' : 'remaining'} result)`, async t => {
  const { page, setRows, errors } = await open(t, { path: systemPath, rows: [workRow('remove'), workRow('keep')] });
  await panelTasks(page, ['remove', 'keep']);
  await page.locator('#system-work-flow [data-task-id="loop:remove"]').focus();
  setRows(empty ? [] : [workRow('keep')]);
  await manualRefresh(page);
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
    await page.locator('[data-work-view="history"]').click();
    const card = page.locator('.completed-card').filter({ hasText: 'Synthetic release' });
    await card.waitFor();
    await card.focus();
    await card.evaluate(node => { window.focusedLiveCard = node; });
    tasks = change === 'updated' ? { released: { ...released, summary: 'Updated summary', work_request: 'WR-102' }, keep: tasks.keep }
      : change === 'removed' ? { keep: tasks.keep } : {};
    version++;
    await page.clock.runFor(60_000);
    await page.waitForFunction(() => document.querySelector('#board-publication').textContent.includes('Snapshot generation 2'));
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
    await page.locator('[data-work-view="history"]').click();
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
      await card.waitFor({ state: 'detached' });
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
  const { page, errors } = await open(t, {width, path:projectPath, snapshotData:hierarchy});
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
