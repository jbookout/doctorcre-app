import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './browser-harness.mjs';
import { routeContract as routes } from '../js/routes.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = process.env.DOCTORCRE_FIXTURE_ROOT || root;
const now = '2026-10-01T12:00:00Z';
const observation = (task_id, references = []) => ({ schema: 'work-linkage.v1', state: 'complete',
  subject: { board_id: 'demo-project', task_id, version: 7 }, references, reason: null });
const taskRows = () => ({
  'demo-dependent': { title: 'Demo release check', status: 'blocked',
    blocked_reason: 'Waiting for the source contract', updated_at: now,
    linkage: observation('demo-dependent', [
      { relation: 'blocked_by', ref: 'demo-blocker', title: 'Demo source contract', state: 'resolved', target: { board_id: 'demo-project', task_id: 'demo-blocker' } },
      { relation: 'plan', ref: 'plan:demo-missing', title: 'plan:demo-missing', state: 'unresolved', target: null },
    ]) },
  'demo-blocker': { title: 'Demo source contract', status: 'review', updated_at: now,
    linkage: observation('demo-blocker') },
  'demo-unlinked': { title: 'Demo standalone work', status: 'queued', updated_at: now,
    linkage: observation('demo-unlinked') },
});
async function open(t, { width = 390, task = 'demo-dependent' } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: 'reduce' });
  await page.clock.install({ time: new Date(now) });
  const state = { denied: false, offline: false, unobserved: false }, errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/mcp') {
      if (state.denied) return route.fulfill({ status: 403, body: '{}' });
      if (state.offline) return route.fulfill({ status: 503, body: '{}' });
      const rpc = route.request().postDataJSON().params;
      const tasks = taskRows();
      if (state.unobserved) { delete tasks[task].linkage; tasks[task].unlinked = true; tasks[task].related = []; }
      const payload = rpc.name === 'read-progress-board'
        ? { ok: true, snapshot: { board_id: 'demo-project', version: 7, updated_at: now,
          snapshot_json: { title: 'Demo dependency review', tasks } }, questions: [] }
        : rpc.name === 'read-session-identity' ? { sessions: [], permission_filtered: false }
          : rpc.name === 'list-progress-boards' ? { schema: 'progress-board-directory.v1', boards: [{ board_id: 'demo-project', title: 'Demo dependency review', updated_at: now, task_counts: {} }] }
            : { schema: 'unfinished-work.v1', items: [], coverage: [], census_complete: true };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { content: [{ text: JSON.stringify(payload) }] } }) });
    }
    if (url.pathname === '/api/room/turns') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, turns: [], latest_seq: 0, more: false, csrf_token: 'synthetic-csrf', actor: { slug: 'joe' } }) });
    if (url.pathname === '/api/room/queue') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ live: true, projected_at: now, events: [] }) });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ contentType: 'application/json', body: '{}' });
    const file = routes.routes[url.pathname] || url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(resolve(source, file)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`http://localhost/control-room/progress/work?board=demo-project&task=${task}`);
  await page.waitForFunction(() => document.getElementById('workTitle')?.textContent !== 'Work detail');
  return { page, state, errors };
}
const out = new URL('../out/test-artifacts/v2-slice10/', import.meta.url);
for (const width of [1440, 390]) test(`blocker links reach the exact other work item and dangling links stay unresolved at ${width}px`, async t => {
  const { page, errors } = await open(t, { width });
  const panel = page.locator('#workDependencies .work-dependencies');
  await panel.waitFor({ timeout: 3000 });
  assert.match(await panel.textContent(), /Blocked by/i);
  const blocker = panel.getByRole('link', { name: /Demo source contract/ });
  await blocker.waitFor();
  const target = new URL(await blocker.getAttribute('href'), 'http://localhost');
  assert.equal(target.searchParams.get('board'), 'demo-project');
  assert.equal(target.searchParams.get('task'), 'demo-blocker');
  assert.equal(target.searchParams.has('work_request'), false);
  assert.match(await panel.textContent(), /plan:demo-missing/);
  assert.match(await panel.textContent(), /Unresolved/);
  assert.equal(await panel.locator('a').filter({ hasText: 'plan:demo-missing' }).count(), 0);
  const box = await blocker.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height, 'the blocker action is visible without scrolling');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: new URL(`dependencies-${width}.png`, out).pathname });
  await blocker.click();
  await page.waitForFunction(() => document.getElementById('workTitle')?.textContent === 'Demo source contract');
  assert.equal(new URL(page.url()).searchParams.get('task'), 'demo-blocker');
  assert.deepEqual(errors, []);
});
for (const width of [1440, 390]) test(`confirmed unlinked stays distinct from unloaded and denied linkage at ${width}px`, async t => {
  const { page, state, errors } = await open(t, { width, task: 'demo-unlinked' });
  const panel = page.locator('#workDependencies .work-dependencies');
  await panel.waitFor({ timeout: 3000 });
  assert.equal(await panel.getAttribute('data-linkage-state'), 'unlinked');
  assert.match(await panel.textContent(), /Unlinked/);
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: new URL(`unlinked-${width}.png`, out).pathname });
  state.unobserved = true; await page.clock.runFor(5100);
  await page.waitForFunction(() => document.querySelector('#workDependencies [data-linkage-state]')?.dataset.linkageState === 'unavailable');
  assert.doesNotMatch(await panel.textContent(), /\bUnlinked\b/);
  state.denied = true; await page.clock.runFor(5100);
  await page.waitForFunction(() => document.getElementById('workReadState')?.dataset.state === 'stale');
  assert.equal(await page.locator('#workDependencies a').count(), 0);
  assert.doesNotMatch(await page.locator('#workDependencies').textContent(), /\bUnlinked\b/);
  assert.deepEqual(errors, []);
});

test('source failure removes previously usable dependency links', async t => {
  const { page, state, errors } = await open(t);
  await page.locator('#workDependencies a').first().waitFor();
  state.offline = true; await page.clock.runFor(5100);
  await page.waitForFunction(() => document.getElementById('workReadState')?.dataset.state === 'stale');
  assert.equal(await page.locator('#workDependencies a').count(), 0);
  assert.doesNotMatch(await page.locator('#workDependencies').textContent(), /\bUnlinked\b/);
  assert.deepEqual(errors, []);
});

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) test(`dependency identifiers and popup priority at ${width}px ${theme}`, async t => {
  const { page, errors } = await open(t, { width });
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  const identifier = page.locator('#workDependencies small').first();
  assert.ok(await identifier.evaluate(node => parseFloat(getComputedStyle(node).fontSize)) >= 13, 'secondary identifiers meet the 13px minimum');
  await page.addStyleTag({ url: 'http://localhost/css/control-room-workspace.css' });
  await page.evaluate(async task => {
    document.body.insertAdjacentHTML('beforeend', '<dialog id="jobDialog" class="job-dialog" aria-labelledby="jobTitle"><header><button id="jobClose" aria-label="Close job details">×</button></header><h2 id="jobTitle"></h2><div id="jobBody"></div></dialog>');
    const { mountJobDetail } = await import('/js/job-detail.js');
    window.reviewDetail = mountJobDetail({ client: {}, document });
    window.reviewTask = task;
    window.reviewDetail.open(task);
  }, { ...taskRows()['demo-dependent'], id: 'demo-dependent', version: 7, title: 'Demo release check', summary: 'Waiting for the source contract' });
  const panel = page.locator('#jobBody .work-dependencies');
  const blocker = panel.getByRole('link', { name: 'Demo source contract' });
  const box = await blocker.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height, 'popup blocker is visible without scrolling');
  assert.equal(await page.locator('#jobBody details[data-job-metadata]').getAttribute('open'), null);
  assert.equal(await page.locator('#jobBody details[data-job-metadata] > summary').evaluate(node => getComputedStyle(node).display), 'list-item', 'metadata has a native disclosure indicator');
  assert.ok(await panel.evaluate(node => node.previousElementSibling.className === 'job-summary'));
  assert.ok(await page.locator('#jobDialog').evaluate(node => node.scrollWidth <= node.clientWidth), 'popup has no horizontal overflow');
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: new URL(`popup-${width}-${theme}.png`, out).pathname });
  await page.locator('#jobBody summary[data-job-control=metadata]').click();
  assert.match(await page.locator('#jobBody details[data-job-metadata]').innerText(), /Owner.*Status.*Agent.*Model.*Effort/s);
  await page.evaluate(() => window.reviewDetail.update([window.reviewTask]));
  assert.notEqual(await page.locator('#jobBody details[data-job-metadata]').getAttribute('open'), null, 'metadata stays expanded after refresh');
  await page.locator('#jobBody summary[data-job-control=metadata]').click();
  await page.evaluate(() => window.reviewDetail.update([], { state: 'unknown' }));
  assert.match(await panel.textContent(), /The source record is unavailable/);
  assert.match(await panel.textContent(), /Refresh this page to retry/);
  await page.screenshot({ path: new URL(`unavailable-${width}-${theme}.png`, out).pathname });
  assert.deepEqual(errors, []);
});
