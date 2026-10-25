import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, waitForAsync, pausedClock } from './browser-harness.mjs';

const root = new URL('../', import.meta.url);
async function open(t, { deal = '', holdBoard = false, holdFeed = false } = {}) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await pausedClock(page, new Date('2026-10-04T17:00:00Z'));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ contentType: 'application/json', body: '{}' });
    const file = url.pathname === '/deals' ? 'pipeline.html' : url.pathname.slice(1);
    try {
      let body = await readFile(new URL(file, root));
      if (file === 'js/fixture-client.js') body = body.toString().replace('export async function createFixtureClient', 'async function fixtureClient') + `
        export async function createFixtureClient(options) {
          const client = await fixtureClient(options);
          window.panelReads ||= { getDeal: 0, correspondenceReadiness: 0, getRelationshipNetwork: 0, getPartyRecord: 0 };
          for (const name of Object.keys(window.panelReads)) {
            const read = client[name].bind(client);
            client[name] = async (...args) => { window.panelReads[name]++; if (name === 'getDeal' && window.holdDetail) await new Promise(resolve => window.releaseDetail = resolve); return read(...args); };
          }
          const board = client.getBoard.bind(client), feed = client.getChanges.bind(client);
          client.getBoard = async (...args) => { ${holdBoard ? 'await new Promise(resolve => { (window.boardReleases ||= []).push(resolve); window.releaseBoard = () => window.boardReleases.splice(0).forEach(release => release()); });' : ''} return board(...args); };
          client.getChanges = async (...args) => { ${holdFeed ? 'await new Promise(resolve => window.releaseFeed = resolve);' : ''} return feed(...args); };
          return client;
        }`;
      return route.fulfill({ body, contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/deals' + (deal ? '?deal=' + deal : ''));
  return page;
}

test('one card-body tap reads one detail and leaves unopened supporting sections unread', async t => {
  const page = await open(t);
  await page.locator('.kanban-card[data-id="d14"]').waitFor();
  await page.locator('.kanban-card[data-id="d14"] .work-meta').click();
  await page.locator('#detailUpdateForm').waitFor();
  assert.deepEqual(await page.evaluate(() => window.panelReads), { getDeal: 1, correspondenceReadiness: 0, getRelationshipNetwork: 0, getPartyRecord: 0 });
  await page.locator('#panelEvidenceSection > summary').click();
  await page.waitForFunction(() => window.panelReads.correspondenceReadiness === 1);
  await page.locator('#panelContextOpen').click();
  await page.waitForFunction(() => window.panelReads.getRelationshipNetwork === 1);
});

for (const hold of ['holdBoard', 'holdFeed']) test(`an exact deal opens while the unrelated ${hold} read is pending`, async t => {
  const page = await open(t, { deal: 'd14', [hold]: true });
  await waitForAsync(page, name => typeof window[name] === 'function', hold === 'holdBoard' ? 'releaseBoard' : 'releaseFeed');
  await page.locator('#detailUpdateForm').waitFor({ timeout: 2000 });
  assert.equal(await page.locator('#detailUpdateForm').count(), 1, 'independently authorized exact detail is already usable');
  assert.equal(await page.evaluate(() => window.panelReads.getDeal), 1);
  if (hold === 'holdBoard') {
    assert.equal(await page.locator('#detailPhase').count(), 0);
    await page.evaluate(() => window.releaseBoard());
    await page.locator('#detailPhase').waitFor({ timeout: 2000 });
    assert.equal(await page.evaluate(() => window.panelReads.getDeal), 1, 'board arrival enables controls without rereading detail');
  }
});

test('overlapping detail refreshes share a read and an unchanged board does not reread the panel', async t => {
  const page = await open(t);
  await page.locator('.kanban-card[data-id="d14"] .card-open').click();
  await page.locator('#detailUpdateForm').waitFor();
  await page.evaluate(() => { window.holdDetail = true; });
  await page.locator('[data-refresh-detail]').click();
  await page.waitForFunction(() => typeof window.releaseDetail === 'function');
  await page.locator('[data-refresh-detail]').click();
  await page.evaluate(async () => (await import('/js/pipeline.js')).state.boardSync.refreshBoard({ reason: 'test-unchanged' }));
  assert.equal(await page.evaluate(() => window.panelReads.getDeal), 2);
  await page.evaluate(() => window.releaseDetail());
  await page.locator('#dealUpdate').fill('Synthetic draft during refresh');
  assert.equal(await page.locator('#dealUpdate').inputValue(), 'Synthetic draft during refresh');
});

test('a newer board version during an in-flight detail read queues one fresh read', async t => {
  const page = await open(t);
  await page.locator('.kanban-card[data-id="d14"] .card-open').click();
  await page.locator('#detailUpdateForm').waitFor();
  await page.locator('#dealUpdate').fill('Synthetic draft while a newer version arrives');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const readDetail = state.client.getDeal.bind(state.client);
    const readBoard = state.client.getBoard.bind(state.client);
    window.versionReads = 0;
    state.client.getDeal = async (...args) => {
      const snapshot = await readDetail(...args);
      const read = ++window.versionReads;
      if (read === 1) await new Promise(resolve => { window.releaseOldVersion = resolve; });
      return read === 1 ? snapshot : { ...snapshot, deal: { ...snapshot.deal, name: 'Synthetic newer deal version' } };
    };
    state.client.getBoard = async (...args) => {
      const board = await readBoard(...args);
      return { ...board, deals: board.deals.map(deal => deal.id === 'd14' ? { ...deal, name: 'Synthetic newer deal version', version: (deal.version || 1) + 1 } : deal) };
    };
  });
  await page.locator('[data-refresh-detail]').click();
  await page.waitForFunction(() => typeof window.releaseOldVersion === 'function');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    await state.boardSync.refreshBoard({ reason: 'synthetic-new-version' });
    window.releaseOldVersion();
  });
  await waitForAsync(page, () => document.querySelector('#panelTitle').textContent === 'Synthetic newer deal version', undefined, 2000);
  assert.equal(await page.evaluate(() => window.versionReads), 2, 'one follow-up read observes the known change');
  assert.equal(await page.locator('#dealUpdate').inputValue(), 'Synthetic draft while a newer version arrives');
});

test('closing an evidence disclosure cannot hide a pending authorization denial', async t => {
  const page = await open(t);
  await page.locator('.kanban-card[data-id="d14"] .card-open').click();
  await page.locator('#detailUpdateForm').waitFor();
  await page.locator('#dealUpdate').fill('Synthetic draft revoked with this session');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    state.client.correspondenceReadiness = () => new Promise((resolve, reject) => {
      window.refuseEvidence = () => reject(Object.assign(new Error('Synthetic authorization denial'), { status: 401 }));
    });
  });
  await page.locator('#panelEvidenceSection > summary').click();
  await page.waitForFunction(() => typeof window.refuseEvidence === 'function');
  await page.locator('#panelEvidenceSection > summary').click();
  await page.evaluate(() => window.refuseEvidence());
  await page.getByText('Unavailable. Sign in to reload this record.', { exact: false }).waitFor();
  assert.equal(await page.locator('#detailUpdateForm').count(), 0);
  assert.equal(await page.locator('#panelTitle').textContent(), 'Deal');
  await page.locator('[data-refresh-detail]').click();
  await page.locator('#dealUpdate').waitFor();
  assert.equal(await page.locator('#dealUpdate').inputValue(), '', 'denied session revokes the unsent draft');
});

test('Evidence Retry still works after closing and reopening unchanged evidence', async t => {
  const page = await open(t);
  await page.locator('.kanban-card[data-id="d14"] .card-open').click();
  await page.locator('#detailUpdateForm').waitFor();
  const summary = page.locator('#panelEvidenceSection > summary');
  await summary.click();
  await page.locator('[data-evidence-retry]').first().waitFor();
  await summary.click();
  await summary.click();
  await page.waitForFunction(() => window.panelReads.correspondenceReadiness === 2);
  await page.locator('[data-evidence-retry]').first().click();
  await page.waitForFunction(() => window.panelReads.correspondenceReadiness === 3, null, { timeout: 2000 });
});
