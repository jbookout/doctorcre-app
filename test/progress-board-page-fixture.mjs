import { startWorkerFixture } from '../scripts/fixture-http.mjs';
import { appAssetSnapshot } from '../scripts/fixture-app-assets.mjs';
import { fileURLToPath } from 'node:url';
import { chromium } from './browser-harness.mjs';
const boards = [{ board_id: 'carr-v5', title: 'System delivery' }, { board_id: 'demo-project', title: 'Demo project' }];
// Synthetic work-queue jobs, shaped like the carr-mcp work-queue verb.
export const queueJob = (card_id, stage, extra = {}) => ({ card_id, work_request: `WR-${card_id.match(/^WR(\d+)/)[1].padStart(6, '0')}`,
  work_request_title: 'Synthetic board rebuild', slice_ordinal: 1, j_number: 1, priority: 1, executor: 'codex', model: 'synthetic-model',
  pr_evidence_complete: true, effort: 'medium', card_title: 'Synthetic queue work', description: 'Build the synthetic queue card.', created_at: '2026-10-27T12:00:00Z',
  stage, stale: false, prs: [], ...extra });
export const queueRead = (jobs, github = [{ repo: 'jbookout/doctorcre-app', state: 'ok', observed_at: '2026-10-27T12:00:00Z', truncated: false }]) =>
  ({ ok: true, stale_after_hours: 24, jobs, github });
const defaultQueue = queueRead([queueJob('WR14.S1.J1', 'review', { prs: [{ repo: 'jbookout/doctorcre-app', number: 12, url: 'https://github.com/jbookout/doctorcre-app/pull/12',
  title: 'Synthetic PR', draft: false, state: 'open', updated_at: '2026-10-27T12:00:00Z', card_id: 'WR14.S1.J1.app#12' }] })]);
export async function open(t, { unfinished = true, path = '/control-room/progress', boardRead = 'ready', rows = [], queue = defaultQueue, control, width = 390, height = 900, costData, snapshotData, assetRoot, autoMount = true, timezoneId, setupPage } = {}) {
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
            build: { title: `${board.title} task`, status: 'running', updated_at: new Date().toISOString() },
          } } }, questions: [] };
      }
      if (rpc.name === 'work-queue') payload = queue;
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
  };
  const server = await startWorkerFixture({ assets: await appAssetSnapshot(assetRoot && fileURLToPath(assetRoot)), env });
  t.after(() => server.close());
  const origin = server.origin;
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
  return { page, context, calls, errors, setSnapshot: value => { snapshotData = value; }, setQueue: value => { queue = value; }, setRows: value => { rows = value; }, recover: () => { readState = 'ready'; } };
}

export const systemPath = '/control-room/progress/board/carr-v5';
export const projectPath = '/control-room/progress/board/demo-project';
