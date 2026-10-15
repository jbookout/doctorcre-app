import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, fixtureServer } from '../../test/browser-harness.mjs';
import { directoryFixture } from '../../test/fixtures/vendor-directory.synthetic.mjs';
import { prepareStagingRecords, stagingFixtureWriteGuard } from '../../scripts/e2e-staging/records.mjs';
import { runVendorJourney } from '../../scripts/e2e-staging/vendor-journey.mjs';
import { installStagingGuard } from '../../scripts/e2e-staging/engine.mjs';
import { openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import staging from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { fakeAPI } from './record-fixture.mjs';
import { admitFixtureRun } from './fixture-admission.mjs';

const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40),
  carr_source_commit: staging.producer.source_commit };
const response = (value, status = 200) => {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return { status: () => status, headers: () => ({ 'content-type': 'application/json' }),
    body: async () => body, json: async () => JSON.parse(body) };
};

test('served W5 app reads only an owned vendor, filters by owner and opens original entries', { timeout: 180_000 }, async t => {
  admitFixtureRun(t);
  const output = await mkdtemp(join(tmpdir(), 'v1-vendor-journey-'));
  const run = openRun(output, { runId: 'synthetic-vendor-journey', events: null });
  t.after(async () => { run.dispose(); await rm(output, { recursive: true, force: true }); });
  const api = fakeAPI(output, { sourceRelease: release });
  await prepareStagingRecords(output, { ...api, run });
  await prepareStagingRecords(output, { ...api, run, reuseOnly: true, vendorFixture: true });
  const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
  const vendor = plan.records.vendor, entry = plan.records.vendor_entry;
  const server = await fixtureServer({ root: new URL('../../dist/site', import.meta.url).pathname });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());

  const listRow = () => ({ ...directoryFixture(`${STAGING_ORIGIN}/api/v1/business/vendors`).rows[0],
    id: vendor.id, name: vendor.name, ref: vendor.ref, owner_label: 'Joe', owned_by_viewer: true });
  const otherRow = () => directoryFixture(`${STAGING_ORIGIN}/api/v1/business/vendors`).rows[1];
  const fixtureData = url => {
    const parsed = new URL(url);
    const base = directoryFixture(`${STAGING_ORIGIN}/api/v1/business/vendors`);
    const source = { ...base.source, observed_at: new Date().toISOString(),
      valid_until: new Date(Date.now() + 60_000).toISOString() };
    if (parsed.pathname.endsWith(`/${vendor.id}`)) {
      const template = directoryFixture(`${STAGING_ORIGIN}/api/v1/business/vendors/00000000-0000-4000-8000-000000000001`);
      return { ...template, source, record: { ...template.record, id: vendor.id, name: vendor.name, ref: vendor.ref,
        owner_label: 'Joe', owned_by_viewer: true, relationship: { ...template.record.relationship,
          recent_entries: [{ id: entry.id, kind: 'note', when: new Date().toISOString(),
            summary: 'Synthetic staging QA introduction entry', detail: 'Fictional QA evidence only; no contact, referral, or send occurred.' }],
          introductions: [{ id: entry.link_id, kind: 'can_introduce', from_name: vendor.name,
            to_name: 'Synthetic Staging Fixture', note: 'Synthetic staging QA suggested introduction only; no real-world introduction occurred.',
            occurred_at: null, via_party: null }] } } };
    }
    const template = directoryFixture(url);
    const query = template.query;
    if (!query.q && query.owner === 'all')
      return { ...template, source, total: 26, page_count: 2, rows: [otherRow()] };
    const rows = [listRow(), otherRow()].filter(row =>
      (!query.q || row.name.toLowerCase().includes(query.q.toLowerCase())) &&
      (query.owner === 'all' || row.owner_label.toLowerCase() === query.owner));
    return { ...template, source, total: rows.length, page_count: 1, rows };
  };
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  t.after(() => page.context().close());
  const guard = stagingFixtureWriteGuard({ output, release, run });
  await installStagingGuard(page.context(), guard);
  const scoped = guard.forContext();
  const requests = [], refusals = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push([request.method(), url.pathname,
      request.method() === 'POST' && url.pathname === '/mcp' ? request.postDataJSON()?.params?.name : null]);
    try {
      const covered = await scoped.handle(request, async () => {
        if (url.pathname === '/app-release') return response({ service: release.service,
          environment: release.environment, source_commit: release.source_commit });
        if (url.pathname === '/auth/session') return response({ actor: { slug: 'joe' }, e2e_principal: 'e2e-joe' });
        if (url.pathname === '/api/system-work/session') return response({ actor: { slug: 'joe' }, csrf_token: 'synthetic-only' });
        if (url.pathname.startsWith('/api/v1/business/vendors')) return response(fixtureData(url.href));
        if (url.pathname.startsWith('/api/')) return response({ actor: { slug: 'joe' }, items: [] });
        if (url.pathname === '/mcp') {
          const rpc = request.postDataJSON();
          return response({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{"ok":true,"items":[]}' }] } });
        }
        const result = await fetch(server.origin + url.pathname + url.search);
        const bytes = Buffer.from(await result.arrayBuffer());
        return { status: () => result.status, headers: () => Object.fromEntries(result.headers),
          body: async () => bytes };
      });
      await route.fulfill({ status: covered.status(), headers: covered.headers(), body: await covered.body() });
    } catch (error) { refusals.push(error.code || error.message); await route.abort(); }
  });
  await page.goto(`${STAGING_ORIGIN}/vendors`, { waitUntil: 'domcontentloaded' });
  const result = await runVendorJourney({ page, plan, release, run });
  assert.deepEqual(result.actions.map(row => row.action), ['owned-vendor', 'owner-filter', 'owner-reset', 'original-entry', 'vendor-readback']);
  assert.ok(result.actions.every(row => row.fixture_run === plan.run && row.source_pair.source_commit === release.source_commit));
  const automaticReads = new Set(['notification-feed', 'deal-room-board', 'today-triage', 'list-feature-switches',
    'list-doc-suggestions', 'morning-brief', 'find-and-catch-up', 'correspondence-readiness']);
  assert.ok(requests.filter(([method]) => method !== 'GET').every(([method, path, name]) =>
    method === 'POST' && path === '/mcp' && automaticReads.has(name)),
  'W5 normal journey performs only the app shell’s listed read calls');
  assert.deepEqual(refusals.filter(value => value !== 'local-companion-read-blocked'), []);
  assert.deepEqual(errors, []);
  await guard.assertCoverage();

  const foreign = { ...plan, records: { ...plan.records, vendor: { ...vendor, id: '99999999-9999-4999-8999-999999999999' } } };
  await page.goto(`${STAGING_ORIGIN}/vendors`, { waitUntil: 'domcontentloaded' });
  await assert.rejects(runVendorJourney({ page, plan: foreign, release, run }), /receipts refused/);
  assert.ok(requests.every(([, path]) => !path.includes(foreign.records.vendor.id)),
    'foreign fixture refused before a foreign-record request');
});
