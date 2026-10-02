import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { handleDoctorcreRequest } from '../src/worker.js';

const boards = [{ board_id: 'carr-v5', title: 'System delivery' }, { board_id: 'demo-project', title: 'Demo project' }];
async function open(t, { unfinished = true, path = '/control-room/progress', boardRead = 'ready' } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(3000);
  const calls = [], errors = []; let readState = boardRead;
  context.on('page', p => { p.setDefaultTimeout(3000); p.on('pageerror', e => errors.push(e.message)); });
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
        else payload = { schema: 'unfinished-work.v1', items: [], coverage: [], census_complete: true };
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
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}${path}`);
  return { page, context, calls, errors, recover: () => { readState = 'ready'; } };
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
