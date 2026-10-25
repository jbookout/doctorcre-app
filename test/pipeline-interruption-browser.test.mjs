import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, waitForAsync, settles } from './browser-harness.mjs';
const root = new URL('../', import.meta.url);
async function open(t, path = '/deals') {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.clock.install();
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (['/api/system-work/session', '/auth/session'].includes(url.pathname)) return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-only' } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
    const file = url.pathname === '/deals' ? 'pipeline.html' : url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost' + path);
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.size > 0);
  return page;
}
async function room(page, id = 'd14') {
  await page.locator(`.kanban-card[data-id="${id}"] .card-open`).click();
  await page.locator('#dealUpdate').waitFor();
}

test('unsent deal updates survive close, another deal, refresh, and reopen without sending', async t => {
  const page = await open(t);
  await room(page);
  await page.locator('#dealUpdate').fill('Synthetic callback notes still being composed');
  await page.locator('#panelClose').click();
  await page.locator('.kanban-card:not([data-id="d14"]) .card-open').first().click();
  await page.locator('#dealUpdate').waitFor();
  await page.locator('#dealUpdate').fill('Synthetic second deal draft');
  await page.locator('#panelClose').click();
  await room(page);
  assert.equal(await page.locator('#dealUpdate').inputValue(), 'Synthetic callback notes still being composed');
  assert.match(await page.locator('#detailUpdateStatus').textContent(), /unsent/i);
  await page.locator('[data-refresh-detail]').click();
  assert.equal(await page.locator('#dealUpdate').inputValue(), 'Synthetic callback notes still being composed');
  assert.equal(await page.locator('.deal-note').filter({ hasText: 'Synthetic callback notes still being composed' }).count(), 0);
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  assert.equal(await page.locator('#dealUpdate').inputValue(), '');
  await page.locator('#panelClose').click(); await room(page);
  assert.equal(await page.locator('#dealUpdate').inputValue(), '');
});

test('phone Back closes a board-opened room and Forward restores its unsent draft', async t => {
  const page = await open(t);
  const before = await page.evaluate(() => history.length);
  await room(page);
  await page.locator('#dealUpdate').fill('Synthetic phone interruption');
  assert.equal(await page.evaluate(() => history.length), before + 1);
  await page.goBack();
  await settles(async () => assert.equal(await page.locator('#recordPanel').isVisible(), false));
  assert.equal(new URL(page.url()).pathname, '/deals');
  await page.goForward(); await page.locator('#dealUpdate').waitFor();
  assert.equal(await page.locator('#dealUpdate').inputValue(), 'Synthetic phone interruption');
});

test('direct-linked room closes safely to its board', async t => {
  const page = await open(t, '/deals?deal=d14');
  await page.locator('#dealUpdate').waitFor();
  await page.locator('#panelClose').click();
  await settles(async () => assert.equal(await page.locator('#recordPanel').isVisible(), false));
  assert.equal(new URL(page.url()).pathname, '/deals');
  assert.equal(new URL(page.url()).searchParams.has('deal'), false);
});

test('drafts are revoked when the board verifies a different actor', async t => {
  const page = await open(t); await room(page);
  await page.locator('#dealUpdate').fill('Synthetic private draft');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const read = state.client.getBoard;
    state.client.getBoard = async (...args) => ({ ...await read(...args), actor: 'dell' });
    await state.boardSync.refreshBoard({ reason: 'synthetic-account-change' });
  });
  await settles(async () => assert.equal(await page.locator('#dealUpdate').inputValue(), ''));
  await page.locator('#panelClose').click(); await room(page);
  assert.equal(await page.locator('#dealUpdate').inputValue(), '');
});

test('confirmed save clears a draft even when its room closed before the reply', async t => {
  const page = await open(t); await room(page);
  await page.locator('#dealUpdate').fill('Synthetic saved update');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const send = state.client.addDealNote;
    state.client.addDealNote = (...args) => new Promise(resolve => { window.releaseUpdate = async () => resolve(await send(...args)); });
  });
  await page.getByRole('button', { name: 'Add update', exact: true }).click();
  await page.locator('#panelClose').click();
  await page.evaluate(() => window.releaseUpdate());
  await room(page);
  await settles(async () => assert.equal(await page.locator('#dealUpdate').inputValue(), ''));
});
