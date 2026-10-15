import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, fixtureServer } from '../../test/browser-harness.mjs';
import { prepareStagingRecords, stagingFixtureWriteGuard } from '../../scripts/e2e-staging/records.mjs';
import { runTourDraftJourney } from '../../scripts/e2e-staging/tour-draft-journey.mjs';
import { installStagingGuard } from '../../scripts/e2e-staging/engine.mjs';
import { openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import staging from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { fakeAPI } from './record-fixture.mjs';
import { admitFixtureRun } from './fixture-admission.mjs';
import { refuseFixtureCompanionConnection, assertCompanionUnavailable } from './companion-fixture.mjs';

const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40),
  carr_source_commit: staging.producer.source_commit };
const reply = value => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { status: () => 200, headers: () => ({ 'content-type': 'application/json' }),
    body: async () => bytes, json: async () => JSON.parse(bytes) };
};
const id = suffix => `70000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const shellReads = new Set(['notification-feed', 'deal-room-board', 'today-triage', 'list-feature-switches',
  'list-doc-suggestions', 'morning-brief', 'find-and-catch-up', 'correspondence-readiness']);

test('served W6 client draft, undo, search save and reload bind the plan-owned Tour detail', { timeout: 180_000 }, async t => {
  admitFixtureRun(t);
  const output = await mkdtemp(join(tmpdir(), 'v1-tour-drafts-'));
  const run = openRun(output, { runId: 'synthetic-tour-drafts', events: null });
  t.after(async () => { run.dispose(); await rm(output, { recursive: true, force: true }); });
  const api = fakeAPI(output, { sourceRelease: release });
  await prepareStagingRecords(output, { ...api, run });
  await prepareStagingRecords(output, { ...api, run, reuseOnly: true, tourDraftFixture: true });
  const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
  const sourcePair = { app: release.source_commit, carr: release.carr_source_commit };
  const binding = { schema: 'doctorcre-staging-tour-fixture-binding.v1', provenance: 'private_installer_raw_readback',
    run: plan.run, source_pair: sourcePair, tour_id: plan.records.tour.id,
    route_version_id: id(1), excluded_stop_id: id(2), synthetic_property_id: id(3) };
  const stop = { id: binding.excluded_stop_id, property_id: binding.synthetic_property_id, stop_state: 'excluded',
    route_sequence: null, route_label: null, access_coordinate_status: 'unknown', property_name: null,
    property_address: null, name: null, address: null };
  const detail = { id: plan.records.tour.id, name: plan.names.tour, status: 'draft', subject_type: 'client',
    subject_id: plan.records.client.id, route_version_state: 'draft', accepted_route_version: 0,
    route_version_id: binding.route_version_id, projection_id: null, stops: [stop], routes: [{
      id: binding.route_version_id, route_version: 1, accepted: false, routing_source: 'manual',
      routing_provider: null, routing_rights_receipt_id: null, created_by: 'joe', stops: [stop],
    }] };
  const client = { id: plan.records.tour_draft_client.id, name: plan.records.tour_draft_client.name, city: 'Pensacola', state: 'FL',
    vertical: 'Medical office', notes: 'Synthetic QA client only' };
  const server = await fixtureServer({ root: new URL('../../dist/site', import.meta.url).pathname });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  t.after(() => page.context().close());
  const guard = stagingFixtureWriteGuard({ output, release, run });
  await installStagingGuard(page.context(), guard);
  const scoped = guard.forContext();
  const requests = [];
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push([request.method(), url.pathname, url.search,
      request.method() === 'POST' && url.pathname === '/mcp' ? request.postDataJSON()?.params?.name : null]);
    try {
      const response = await scoped.handle(request, async () => {
      refuseFixtureCompanionConnection(request);
      if (url.pathname === '/app-release') return reply({ service: release.service,
        environment: release.environment, source_commit: release.source_commit });
      if (url.pathname === '/auth/session') return reply({ actor: { slug: 'joe' }, e2e_principal: 'e2e-joe' });
      if (url.pathname === '/api/system-work/session') return reply({ actor: { slug: 'joe' }, csrf_token: 'synthetic-only' });
      if (url.pathname === '/api/v1/business/clients') return reply({ data: { rows: [client], page: 1, page_count: 1 }, csrf_token: 'synthetic-only' });
      if (url.pathname === `/api/v1/business/clients/${client.id}`) return reply({ data: { record: client }, csrf_token: 'synthetic-only' });
      if (url.pathname === '/api/tours/library') return reply({ data: { tours: [{ id: detail.id, name: detail.name, status: 'draft' }] }, csrf_token: 'synthetic-only' });
      if (url.pathname === '/api/tours/detail') return reply({ data: detail, csrf_token: 'synthetic-only' });
      if (url.pathname === '/mcp') {
        const rpc = request.postDataJSON();
        return reply({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{"ok":true,"items":[]}' }] } });
      }
      if (url.pathname.startsWith('/api/')) return reply({ items: [] });
      const fetched = await fetch(server.origin + url.pathname + url.search);
      const bytes = Buffer.from(await fetched.arrayBuffer());
      return { status: () => fetched.status, headers: () => Object.fromEntries(fetched.headers), body: async () => bytes };
      });
      await route.fulfill({ status: response.status(), headers: response.headers(), body: await response.body() });
    } catch (error) {
      if (!error.companionRead && error.code !== 'local-companion-read-blocked') throw error;
      await route.abort();
    }
  });
  await page.goto(`${STAGING_ORIGIN}/tours`, { waitUntil: 'domcontentloaded' });
  const result = await runTourDraftJourney({ page, plan, sourcePair, fixtureBinding: binding, run });
  assert.deepEqual(result.actions.map(row => row.action), ['client-prefill', 'edit-undo', 'draft-save', 'draft-reload', 'upcoming-detail']);
  assert.ok(result.actions.every(row => row.fixture_run === plan.run && row.source_pair.source_commit === release.source_commit));
  assert.equal(result.tour.backend_readback.excluded_stop_id, binding.excluded_stop_id);
  assert.ok(requests.filter(([method]) => method !== 'GET').every(([method, path, , name]) =>
    method === 'POST' && path === '/mcp' && shellReads.has(name)));
  await guard.assertCoverage();
  assertCompanionUnavailable(JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8')));
  const beforeForeign = requests.length;
  await assert.rejects(runTourDraftJourney({ page, plan, sourcePair: { ...sourcePair, app: 'b'.repeat(40) },
    fixtureBinding: binding, run }), /refused/);
  assert.equal(requests.length, beforeForeign, 'changed app source refuses before any browser request');
  client.city = ''; client.state = '';
  await assert.rejects(runTourDraftJourney({ page, plan, sourcePair, fixtureBinding: binding, run }), /refused/);
  assert.ok(requests.filter(([method]) => method !== 'GET').every(([method, path, , name]) =>
    method === 'POST' && path === '/mcp' && shellReads.has(name)));
});
