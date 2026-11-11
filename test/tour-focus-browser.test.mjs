import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { chromium } from './browser-harness.mjs';

const deal = '11111111-1111-4111-8111-111111111111';
const tour = '33333333-3333-4333-8333-333333333333';
const routeId = '55555555-5555-4555-8555-555555555555';
const row = { id: tour, deal_id: deal, name: 'Synthetic focus tour', status: 'draft' };

test('focusing Tour notes keeps native typing through an automatic detail read', async t => {
  const artifact = await temporaryDirectory('doctorcre-tour-focus-', t);
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir: artifact, commit: '1'.repeat(40) });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: `${artifact}/site` } });
  t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  let release, reading, hold = false, notes = '', revision = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reading = resolve; });
  t.after(() => release());
  const seed = JSON.parse((await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8')).replaceAll('"d14"', JSON.stringify(deal)));
  await page.route('**/data/board-seed.json', route => route.fulfill({ json: seed }));
  await page.route('**/api/tours/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/tours/library') return route.fulfill({ json: { data: { tours: [row] }, csrf_token: 'synthetic-session' } });
    if (path === '/api/tours/detail') {
      if (hold) { hold = false; reading(); await gate; }
      return route.fulfill({ json: { data: { ...row, cheat_sheet: revision ? { revision_number: revision, content: { notes } } : {}, stops: [],
        routes: [{ id: routeId, route_version: 1, accepted: false, stops: [] }], route_version_id: routeId,
        route_version_state: 'draft', accepted_route_version: 0 }, csrf_token: 'synthetic-session' } });
    }
    if (path === '/api/tours/cheat-sheet/autosave') {
      const body = route.request().postDataJSON();
      assert.equal(body.expected_revision_number, revision);
      notes = body.content.notes; ++revision;
      return route.fulfill({ json: { data: { cheat_sheet_revision_id: routeId, revision_number: revision }, csrf_token: 'synthetic-session' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  await page.goto(`${server.url}/deals?deal=${deal}&tab=tours&tour=${tour}`);
  const editor = page.frameLocator('iframe[title="Tour shortlist, route and packet"]');
  await editor.locator('#tour-name').filter({ hasText: row.name }).waitFor();
  await page.waitForLoadState('networkidle');
  hold = true;
  await editor.locator('#cheat-content').focus();
  await editor.locator('#cheat-content').evaluate(node => node.ownerDocument.defaultView.dispatchEvent(new Event('focus')));
  await started;
  await page.keyboard.insertText('Synthetic workspace edit');
  release();
  await editor.locator('#save-sheet').click();
  await editor.locator('#sheet-state').filter({ hasText: /save confirmed/ }).waitFor();
  assert.equal(notes, 'Synthetic workspace edit');
  assert.equal(await editor.locator('#cheat-content').inputValue(), 'Synthetic workspace edit');
});
