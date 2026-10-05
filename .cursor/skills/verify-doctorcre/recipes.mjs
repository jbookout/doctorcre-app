import assert from 'node:assert/strict';
import { directoryFixture } from '../../../test/fixtures/vendor-directory.synthetic.mjs';
import { workspace, detail as leadDetail, id as leadId } from '../../../test/leads-workspace-fixture.mjs';

const clientId = '11111111-1111-4111-8111-111111111111';
const tourId = '22222222-2222-4222-8222-222222222222';
const client = { id: clientId, name: 'Demo Harbor Practice', city: 'Pensacola', state: 'FL', vertical: 'Medical office', notes: 'Synthetic requirements: accessible ground-floor entry and patient parking.' };
const tour = { id: tourId, name: 'Demo Gulf Coast Tour', status: 'draft', stops: [{ property_name: 'Demo Bayside Office', property_address: '100 Example Way', stop_state: 'active' }] };
const boards = [{ board_id: 'carr-v5', title: 'System delivery' }];
const rpcEnvelope = value => ({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });

async function enter(h, route, label, ready) {
  const { page, origin, action, capture, entry } = h;
  await action(`Open ${label} bookmark ${route}`, () => page.goto(origin + route, { waitUntil: 'domcontentloaded' }));
  await page.locator(ready).first().waitFor({ state: 'attached' }); entry('bookmark', route);
  await capture('entry-bookmark');
  await action('Open shared navigation from another surface', () => page.goto(origin + (route === '/' ? '/deals' : '/'), { waitUntil: 'domcontentloaded' }));
  await action(`Choose ${label} in shared navigation`, () => page.locator(`[data-app-nav-item][aria-label="${label}"]`).click());
  await page.locator(ready).first().waitFor({ state: 'attached' }); entry('shared-navigation', route);
  await capture('entry-navigation');
}

// Only the existing same-origin CARR contract is substituted. Page modules,
// markup, CSS, route dispatch and user interactions come from the local app.
export async function boundary(route, feature) {
  const request = route.request(), url = new URL(request.url());
  if (url.pathname === '/api/system-work/session') {
    await route.fulfill({ json: { actor: { slug: 'joe', label: 'Demo partner' }, csrf_token: 'synthetic-verification-only' } }); return true;
  }
  if (feature === 'vendors' && url.pathname.startsWith('/api/v1/business/vendors')) {
    await route.fulfill({ json: directoryFixture(url.href) }); return true;
  }
  if (feature === 'tours') {
    let data;
    if (url.pathname === '/api/tours/library') data = { tours: [tour] };
    if (url.pathname === '/api/tours/detail') data = tour;
    if (url.pathname === '/api/v1/business/clients') data = { rows: [client], page: 1, page_count: 1 };
    if (url.pathname === `/api/v1/business/clients/${clientId}`) data = { record: client };
    if (data) { await route.fulfill({ json: { data, csrf_token: 'synthetic-verification-only' } }); return true; }
  }
  if (url.pathname === '/mcp') {
    const rpc = request.postDataJSON().params;
    let value = { ok: true };
    if (rpc.name === 'deal-room-board') value = { actor: 'joe', deals: [] };
    else if (rpc.name === 'lead-board' && feature === 'leads') {
      const board = workspace(); value = { ...board, ...(rpc.arguments.lead_id ? { detail: leadDetail(board.leads.find(l => l.id === rpc.arguments.lead_id)) } : {}) };
    } else if (rpc.name === 'list-progress-boards' && feature === 'progress-navigation') value = { schema: 'progress-board-directory.v1', boards };
    else if (rpc.name === 'read-progress-board' && feature === 'progress-navigation') value = { snapshot: { board_id: 'carr-v5', version: 1, updated_at: new Date().toISOString(), snapshot_json: { title: 'System delivery', tasks: { build: { title: 'Synthetic verification task', status: 'running' } } } }, questions: [] };
    else if (rpc.name === 'unfinished-work') value = { schema: 'unfinished-work.v1', items: [], coverage: [], census_complete: true };
    else if (rpc.name === 'list-doc-suggestions') value = { ok: true, suggestions: [] };
    else if (rpc.name === 'find-and-catch-up') value = { state: 'not_found', candidates: [] };
    else if (!['list-notifications', 'notification-feed', 'correspondence-readiness'].includes(rpc.name)) {
      await route.fulfill({ status: 400, json: { error: 'unmapped_synthetic_contract', name: rpc.name } }); return true;
    }
    await route.fulfill({ json: rpcEnvelope(value) }); return true;
  }
  return false;
}

export const recipes = {
  home: async h => {
    const { page, origin, action, capture, check, entry } = h;
    await enter(h, '/', 'Home', '#dealFlags .home-flag');
    await page.locator('#dealFlags .home-flag').first().waitFor();
    await capture('before');
    const teamCount = await page.locator('#dealFlags .home-flag').count();
    await check('Synthetic Team View has four flags', async () => assert.equal(teamCount, 4));
    await action('Choose Just Me', () => page.getByRole('button', { name: 'Just Me', exact: true }).click());
    await check('Just Me scopes deal attention to two flags', async () => assert.equal(await page.locator('#dealFlags .home-flag').count(), 2));
    await capture('action');
    await action('Choose Team View', () => page.getByRole('button', { name: 'Team View', exact: true }).click());
    await check('Team View restores all four deal flags', async () => {
      assert.equal(await page.locator('#dealFlags .home-flag').count(), 4);
      assert.equal(await page.getByRole('button', { name: 'Team View', exact: true }).getAttribute('aria-pressed'), 'true');
    });
    const link = page.locator('#dealFlags .home-flag').first(), href = await link.getAttribute('href');
    const id = new URL(href, origin).searchParams.get('deal');
    await action(`Open flagged deal ${id}`, () => link.click());
    await page.locator('#detailPhase').waitFor();
    entry('local-deals:home-attention', href);
    await check('Flag opens its addressed deal', async () => {
      assert.equal(new URL(page.url()).searchParams.get('deal'), id);
      assert.equal(await page.locator('#panelTitle').innerText(), 'Demo Dental North');
      assert.equal(await page.locator('#recordPanel').evaluate(n => n.open), true);
    });
    await capture('after');
  },
  leads: async h => {
    const { page, action, capture, check } = h;
    const allIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 19, 20].map(leadId).sort();
    const pensacolaIds = [1, 2, 3, 4, 5, 6, 7, 9, 11, 12, 19, 20].map(leadId).sort();
    const boardIds = () => page.locator('#leadBoard .lead-card').evaluateAll(nodes => nodes.map(node => node.dataset.leadId).sort());
    await enter(h, '/leads', 'Leads', '.lead-card');
    await page.locator('.lead-card').first().waitFor();
    await page.locator('.market-marker').first().waitFor({ state: 'attached' });
    await capture('before');
    if (!(await page.locator('#stageFilter').isVisible())) await action('Open Lead filters sidebar', () => page.locator('#appSidebarToggle').click());
    await action('Filter stage Qualified', () => page.locator('#stageFilter').selectOption('qualified'));
    await check('Qualified stage shows only Gulf Breeze lead', async () => assert.deepEqual(await boardIds(), [leadId(8)]));
    await action('Restore All stages', () => page.locator('#stageFilter').selectOption(''));
    await check('All stages restores the fourteen eligible board cards', async () => assert.deepEqual(await boardIds(), allIds));
    await capture('restored-all');
    await action('Choose Pensacola market', () => page.locator('#marketCounts [data-market="Pensacola, FL"]').click());
    await check('Pensacola market shows its twelve board cards and keeps the map', async () => {
      assert.equal(await page.locator('#marketFilter').inputValue(), 'Pensacola, FL');
      assert.deepEqual(await boardIds(), pensacolaIds);
      assert.ok(await page.locator('.market-marker').count() > 0);
    });
    await capture('action');
    const card = page.locator('.lead-card').first(), title = await card.getAttribute('aria-label');
    await action(`Open ${title}`, () => card.click());
    await page.locator('#detailBody details').first().waitFor();
    await action('Expand lead original entry', () => page.locator('#detailBody details summary').first().click());
    await check('Lead detail matches selected card and has originals', async () => {
      assert.equal(await page.locator('#detailTitle').innerText(), title);
      assert.match(await page.locator('#detailBody').innerText(), /Original synthetic|Synthetic original/);
    });
    await capture('after');
    await action('Close lead detail with Escape', () => page.keyboard.press('Escape'));
    await check('Lead detail closes and returns focus', async () => {
      assert.equal(await page.locator('#leadDetail').evaluate(n => n.open), false);
      assert.equal(await card.evaluate(n => document.activeElement === n), true);
    });
  },
  tours: async h => {
    const { page, action, capture, check } = h;
    await enter(h, '/tours', 'Tours', '#plan-client option[value="' + clientId + '"]');
    await page.waitForFunction(() => document.querySelector('#plan-client')?.options.length === 2);
    await capture('before');
    await action('Choose Demo Harbor Practice', () => page.locator('#plan-client').selectOption(clientId));
    await page.waitForFunction(() => document.querySelector('#plan-name').value.includes('Demo Harbor'));
    await action('Type a tour area', () => page.locator('#plan-area').fill('Typed synthetic area'));
    await action('Undo tour edit', () => page.getByLabel('Undo tour edit', { exact: true }).click());
    await check('Undo restores client area', async () => assert.equal(await page.locator('#plan-area').inputValue(), 'Pensacola, FL'));
    await action('Choose October 8 tour date', () => page.locator('#plan-date').fill('2026-10-08'));
    await action('Set search area Pensacola, FL', () => page.locator('#space-area').fill('Pensacola, FL'));
    await action('Set minimum space size', () => page.locator('#space-minSize').fill('1800'));
    await action('Enter accessible ground-floor requirements', () => page.locator('#space-requirements').fill('Ground floor · accessible entry'));
    await action('Save search draft', () => page.locator('#save-search').click());
    await check('Draft save confirmed', async () => assert.match(await page.locator('#space-message').innerText(), /saved/));
    await capture('action');
    await action('Reload Tours to read saved draft', () => page.reload({ waitUntil: 'domcontentloaded' }));
    await page.waitForFunction(() => document.querySelector('#space-minSize')?.value === '1800');
    await check('Saved tab draft survives reload', async () => {
      assert.equal(await page.locator('#space-minSize').inputValue(), '1800');
      assert.equal(await page.locator('#plan-client').inputValue(), clientId);
      assert.equal(await page.locator('#plan-date').inputValue(), '2026-10-08');
      assert.equal(await page.locator('#space-requirements').inputValue(), 'Ground floor · accessible entry');
      const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('doctorcre-tour-planning-drafts-v1')));
      assert.equal(stored.search.minSize, '1800');
    });
    await capture('after');
    await action('Open upcoming Demo Gulf Coast Tour', () => page.locator('#upcoming-tours .tour-button').first().click());
    await page.waitForFunction(() => document.querySelector('#detail-title').textContent === 'Demo Gulf Coast Tour');
    await capture('library-detail');
    await action('Close tour detail with Escape', () => page.keyboard.press('Escape'));
    await check('Tour detail closes with Escape', async () => assert.equal(await page.locator('#tour-dialog').evaluate(n => n.open), false));
  },
  'local-deals': async h => {
    const { page, origin, action, capture, check, entry } = h;
    await enter(h, '/deals', 'Local Deals', '.kanban-card');
    const card = page.locator('.kanban-column [data-id="d23"]'); await card.waitFor();
    await capture('before');
    await action('Drag Demo Specialty Clinic to Legal', () => card.dragTo(page.locator('[data-column="legal"]')));
    await page.locator('#completionDialog[open]').waitFor();
    await check('Drag opens review before mutation', async () => assert.equal(await page.locator('[data-column="negotiation"] [data-id="d23"]').count(), 1));
    await capture('action');
    await action('Confirm reviewed phase move', () => page.locator('#completionConfirm').click());
    await page.locator('[data-column="legal"] [data-id="d23"]').waitFor();
    await action('Open moved deal through board', () => page.locator('[data-column="legal"] [data-id="d23"]').click());
    await page.locator('#detailPhase').waitFor();
    await check('Second user view confirms Legal', async () => assert.equal(await page.locator('#detailPhase').inputValue(), 'legal'));
    await capture('after');
    await action('Open Home attention entry for local deal', () => page.goto(origin + '/', { waitUntil: 'domcontentloaded' }));
    await action('Open Demo Specialty Clinic flag', () => page.locator('#dealFlags .home-flag[href="/deals?deal=d23"]').click());
    await page.locator('#detailPhase').waitFor();
    await check('Home attention opens local deal detail', async () => {
      assert.equal(await page.locator('#panelTitle').innerText(), 'Demo Specialty Clinic');
      assert.equal(new URL(page.url()).searchParams.get('deal'), 'd23');
    });
    entry('home-attention', '/deals?deal=d23');
    await capture('home-attention');
  },
  vendors: async h => {
    const { page, action, capture, check } = h;
    await enter(h, '/vendors', 'Vendors', '.record-row');
    await page.locator('.record-row').first().waitFor(); await capture('before');
    await action('Choose Dell owner', () => page.locator('[data-owner="dell"]').click());
    await page.waitForFunction(() => document.querySelector('#resultSummary').textContent.startsWith('31 '));
    await check('Owner read reports Dell subset', async () => assert.equal(new URL(page.url()).searchParams.get('owner'), 'dell'));
    await capture('action');
    await action('Reset filters', () => page.locator('#resetFilters').click());
    await page.waitForFunction(() => document.querySelector('#resultSummary').textContent.startsWith('62 '));
    await action('Open Demo Partner 01', () => page.locator('.record-row').first().click());
    await page.locator('[data-details-key="entry-demo-entry"] summary').waitFor();
    await action('Expand original relationship entry', () => page.locator('[data-details-key="entry-demo-entry"] summary').click());
    await check('Record view shows original synthetic email', async () => assert.match(await page.locator('[data-details-key="entry-demo-entry"]').innerText(), /Original synthetic email/));
    await action('Expand original introduction', () => page.locator('[data-details-key="intro-demo-intro"] summary').click());
    await check('Introduction has its original entry', async () => assert.match(await page.locator('[data-details-key="intro-demo-intro"]').innerText(), /Original synthetic introduction entry/));
    await capture('after');
    await action('Close vendor detail with Escape', () => page.keyboard.press('Escape'));
    await check('Vendor detail closes with Escape', async () => assert.equal(await page.locator('#recordPanel').isVisible(), false));
  },
  'progress-navigation': async ({ page, context, origin, action, capture, check, entry }) => {
    await action('Open Progress directory', () => page.goto(origin + '/control-room/progress', { waitUntil: 'domcontentloaded' }));
    const link = page.locator('[data-board-id="carr-v5"]'); await link.waitFor();
    entry('bookmark', '/control-room/progress');
    await capture('before');
    const target = await link.getAttribute('target');
    const newPage = target === '_blank' ? context.waitForEvent('page') : null;
    await action('Open System delivery board tile', () => link.click());
    const board = newPage ? await newPage : page;
    await board.waitForLoadState('domcontentloaded');
    await capture('action', board);
    entry('directory-tile', board.url());
    await check('Board tile opens a separate tab', async () => {
      assert.equal(target, '_blank'); assert.notEqual(board, page);
    });
    await check('Board tile opens its dedicated board page', async () => {
      assert.equal(new URL(board.url()).pathname, '/control-room/progress/board/carr-v5');
    });
    await board.locator('#board-stages [data-card-id="build"]').waitFor();
    await check('Dedicated board shows its published task', async () => {
      assert.equal(await board.locator('.directory-panel').isVisible(), false);
      assert.equal(await board.locator('#board-stages .column').count(), 6);
    });
    await capture('after', board);
    await action('Open legacy board bookmark', () => page.goto(origin + '/control-room/progress?board=carr-v5', { waitUntil: 'domcontentloaded' }));
    await page.locator('#board-stages [data-card-id="build"]').waitFor();
    await check('Legacy bookmark resolves dedicated board', async () => assert.equal(new URL(page.url()).pathname, '/control-room/progress/board/carr-v5'));
    entry('legacy-bookmark', '/control-room/progress?board=carr-v5');
    await capture('legacy-bookmark');
  },
};
