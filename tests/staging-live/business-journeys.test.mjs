import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, fixtureServer } from '../../test/browser-harness.mjs';
import { prepareStagingRecords, stagingFixtureWriteGuard, assertStagingWriteCoverage } from '../../scripts/e2e-staging/records.mjs';
import { runBusinessJourneys } from '../../scripts/e2e-staging/business-journeys.mjs';
import { openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import staging from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { fakeAPI } from './record-fixture.mjs';
import { admitFixtureRun } from './fixture-admission.mjs';

const release = { service: 'doctorcre-app', environment: 'staging', source_commit: '12181a8136e6e6030d5e8ed9dbeed6518ee258a4', carr_source_commit: staging.producer.source_commit };
const bodyResponse = (value, status = 200) => {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return { status: () => status, headers: () => ({ 'content-type': 'application/json' }), body: async () => body, json: async () => JSON.parse(body) };
};

test('served signed-in app W4/W9 uses the real UI, canonical fixture guard and durable receipts', { timeout: 180_000 }, async t => {
  admitFixtureRun(t);
  const output = await mkdtemp(join(tmpdir(), 'business-journeys-'));
  const run = openRun(output, { runId: 'synthetic-business-journeys', events: null });
  t.after(async () => { run.dispose(); await rm(output, { recursive: true, force: true }); });
  const api = fakeAPI(output, { sourceRelease: release });
  const setup = await prepareStagingRecords(output, { ...api, run });
  const planPath = join(output, 'staging-records-plan.json');
  const baseline = JSON.parse(await readFile(planPath, 'utf8'));
  const server = await fixtureServer({ root: new URL('../../dist/site', import.meta.url).pathname });
  t.after(() => server.close());
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
  t.after(() => browser.close());
  const deal = setup.records.deal.id;

  async function fixture({ lose = null } = {}) {
    await writeFile(planPath, JSON.stringify(baseline), { mode: 0o600 });
    const guard = stagingFixtureWriteGuard({ output, release, run });
    const scoped = guard.forContext();
    const detail = { ...structuredClone(api.rows.deals.get(deal)), field_base: {}, events: [], critical_dates: [], thread: [], next_actions: [], activities: [], participants: [], premises: [], negotiation_rounds: [], documents: [] };
    const writes = [], reads = [], denied = [], errors = [], admittedBeforeUI = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      try {
        const response = await scoped.handle(request, async () => {
          if (url.pathname === '/mcp') {
            const rpc = request.postDataJSON(), { name, arguments: args } = rpc.params;
            const rpcReply = value => bodyResponse({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
            if (name === 'deal-room-board') return rpcReply({ actor: 'joe', deals: [detail], unplaced_count: 0 });
            if (name === 'get-deal-room') { reads.push(args.deal); return rpcReply(structuredClone(detail)); }
            if (['patch-deal-field', 'revert-deal-field', 'add-critical-date'].includes(name)) {
              const plan = JSON.parse(await readFile(planPath, 'utf8'));
              const row = plan.browser_write_attempts.find(row => row.arguments.idempotency_key === args.idempotency_key);
              assert.equal(row.state, 'inflight');
              assert.equal(row.journey.state, 'admitted');
              assert.equal(row.journey.fixture_run, baseline.run);
              assert.ok(row.journey.admitted_at <= row.attempted_at, 'intent precedes the UI request');
              assert.deepEqual(row.journey.release, baseline.release);
              writes.push({ name, args: structuredClone(args) });
              let value;
              if (name === 'add-critical-date') {
                const id = randomUUID();
                detail.critical_dates.push({ id, deal_id: deal, kind: args.kind, due_on: args.due_on, source: args.source, note: null });
                value = { ok: true, critical_date_id: id };
              } else {
                const prior = detail.events.find(event => event.id === args.event_id);
                const old = detail.phase, next = name === 'patch-deal-field' ? args.value : prior.old_value.phase;
                const event = { id: randomUUID(), subject_id: deal, subject_type: 'deal', field: 'phase', verb: name, actor: 'joe', old_value: { phase: old }, new_value: { phase: next }, recorded_at: new Date().toISOString() };
                detail.phase = next;
                detail.field_base.phase = { event_id: event.id, recorded_at: event.recorded_at };
                detail.events.push(event);
                value = { ok: true, deal_id: deal, field: 'phase', old_value: old, new_value: next, event_id: event.id, event_recorded_at: event.recorded_at,
                  ...(name === 'revert-deal-field' ? { reverted_event_id: args.event_id } : {}) };
              }
              if (name === lose) throw new Error('Synthetic interrupted response');
              return rpcReply(value);
            }
            return rpcReply({ ok: true, items: [], notifications: [] });
          }
          if (url.pathname === '/app-release') return bodyResponse(release);
          if (url.pathname === '/auth/session') return bodyResponse({ actor: { slug: staging.session.actor_slug }, e2e_principal: staging.session.e2e_principal });
          if (url.pathname === '/pipeline/changes') return bodyResponse({ events: structuredClone(detail.events), presence: [], cursor: null, caught_up: true });
          if (url.pathname.startsWith('/api/')) return bodyResponse({ actor: { slug: 'joe' }, items: [], csrf_token: 'synthetic-only' });
          if (url.origin !== STAGING_ORIGIN) return bodyResponse('');
          const response = await fetch(server.origin + url.pathname + url.search);
          const bytes = Buffer.from(await response.arrayBuffer());
          return { status: () => response.status, headers: () => Object.fromEntries(response.headers), body: async () => bytes, json: async () => JSON.parse(bytes) };
        });
        await route.fulfill({ status: response.status(), headers: response.headers(), body: await response.body() });
      } catch (error) { denied.push(error.code || error.message); await route.abort(); }
    });
    await page.goto(STAGING_ORIGIN + '/deals?deal=' + deal);
    await page.locator('#detailPhase').waitFor();
    const locator = page.locator.bind(page);
    page.locator = selector => {
      const actual = locator(selector);
      const action = selector === '#detailPhase' ? 'selectOption'
        : selector === '#completionConfirm' || selector === '#dealDateForm button[type="submit"]' || selector.startsWith('button[data-undo=') ? 'click' : null;
      if (action) {
        const perform = actual[action].bind(actual);
        actual[action] = async (...args) => {
          const plan = JSON.parse(await readFile(planPath, 'utf8'));
          const pending = plan.browser_write_attempts.filter(row => row.state === 'admitted');
          assert.equal(pending.length, 1, 'one durable exact journey intent exists before touching the real UI');
          assert.equal(pending[0].journey.state, 'admitted');
          admittedBeforeUI.push(pending[0].operation);
          return perform(...args);
        };
      }
      return actual;
    };
    return { page, guard, scoped, detail, writes, reads, denied, errors, admittedBeforeUI };
  }

  await t.test('phase change, event-specific undo and date all have UI results and independent reads', async () => {
    const f = await fixture();
    try {
      const result = await runBusinessJourneys({ page: f.page, fixtureGuard: f.guard, release, deal, run });
      assert.deepEqual(result.completed, ['W4', 'W9']);
      assert.equal(result.full_v1_qualified, false);
      assert.deepEqual(f.writes.map(row => row.name), ['patch-deal-field', 'revert-deal-field', 'add-critical-date']);
      assert.deepEqual(f.admittedBeforeUI, ['patch-deal-field', 'patch-deal-field', 'revert-deal-field', 'add-critical-date']);
      assert.equal(f.detail.phase, 'pending');
      assert.equal(f.detail.critical_dates.length, 1);
      const plan = JSON.parse(await readFile(planPath, 'utf8'));
      for (const row of plan.browser_write_attempts) {
        assert.equal(row.state, 'acknowledged');
        assert.equal(row.journey.state, 'observed');
        assert.equal(row.independent_readback.matched, true);
        assert.equal(row.journey.ui.schema, 'staging-business-journey-ui.v1');
      }
      await assertStagingWriteCoverage(output);
      const count = f.writes.length;
      await runBusinessJourneys({ page: f.page, fixtureGuard: f.guard, release, deal, run });
      assert.equal(f.writes.length, count, 'completed journeys never click or dispatch again');
      assert.deepEqual(f.denied.filter(code => code !== 'local-companion-read-blocked'), []);
      assert.deepEqual(plan.browser_control_proofs, baseline.browser_control_proofs, 'business journeys do not change the read control catalog');
      assert.deepEqual(f.errors, []);
      const changed = structuredClone(plan);
      delete changed.browser_write_attempts[0].journey.ui;
      await writeFile(planPath, JSON.stringify(changed), { mode: 0o600 });
      const restarted = stagingFixtureWriteGuard({ output, release, run });
      await assert.rejects(runBusinessJourneys({ page: f.page, fixtureGuard: restarted, release, deal, run }), /reconciliation/);
      assert.equal(f.writes.length, count, 'a relabeled completion without its UI witness cannot skip or replay');
    } finally { await f.page.context().close(); }
  });

  await t.test('foreign fixture and changed source pair refuse before any click or request', async () => {
    const f = await fixture();
    try {
      for (const spec of [{ deal: randomUUID(), release }, { deal, release: { ...release, source_commit: 'b'.repeat(40) } }, { deal, release: { ...release, carr_source_commit: 'b'.repeat(40) } }]) {
        await assert.rejects(f.guard.admitBusinessJourneyStep({ phase: 'admit', journey: 'W4', step: 'move', ...spec }), /fixture|source|provenance/);
        await assert.rejects(runBusinessJourneys({ page: f.page, fixtureGuard: f.guard, run, ...spec }), /fixture|source|provenance/);
        assert.equal(f.writes.length, 0);
      }
      assert.equal(await f.page.locator('#completionDialog').evaluate(node => node.open), false);
    } finally { await f.page.context().close(); }
  });

  await t.test('interrupted dispatch is durable and rerun sends no second mutation', async () => {
    const f = await fixture({ lose: 'patch-deal-field' });
    try {
      await assert.rejects(runBusinessJourneys({ page: f.page, fixtureGuard: f.guard, release, deal, run, journeys: ['W4'] }), /unresolved|coverage|reconciliation/);
      assert.equal(f.writes.length, 1);
      const plan = JSON.parse(await readFile(planPath, 'utf8'));
      assert.ok(['inflight', 'unresolved'].includes(plan.browser_write_attempts[0].state));
      assert.equal(plan.browser_write_attempts[0].dispatched_outcome, 'unknown');
      const restarted = stagingFixtureWriteGuard({ output, release, run });
      await assert.rejects(runBusinessJourneys({ page: f.page, fixtureGuard: restarted, release, deal, run, journeys: ['W4'] }), /unresolved|coverage|reconciliation/);
      assert.equal(f.writes.length, 1);
    } finally { await f.page.context().close(); }
  });

  await t.test('wrong undo event cannot cross the admitted event binding', async () => {
    const f = await fixture();
    try {
      const admit = f.guard.admitBusinessJourneyStep.bind(f.guard);
      f.guard.admitBusinessJourneyStep = spec => {
        if (spec.step === 'undo' && spec.phase === 'admit') throw new Error('Synthetic pause before undo');
        return admit(spec);
      };
      await assert.rejects(runBusinessJourneys({ page: f.page, fixtureGuard: f.guard, release, deal, run, journeys: ['W4'] }), /Synthetic pause/);
      const intent = await admit({ phase: 'admit', journey: 'W4', step: 'undo', deal, release });
      assert.equal(intent.state, 'admitted');
      await f.page.evaluate(async args => {
        try { await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'revert-deal-field', arguments: args } }) }); }
        catch {}
      }, { event_id: randomUUID(), idempotency_key: randomUUID() });
      assert.equal(f.writes.length, 1);
      assert.ok(f.denied.includes('journey-request-unproved'));
      const persisted = JSON.parse(await readFile(planPath, 'utf8'));
      assert.equal(persisted.browser_write_attempts[1].state, 'admitted');
      assert.equal(persisted.browser_write_attempts[1].argument_template.event_id, intent.argument_template.event_id);
      await assert.rejects(f.guard.assertCoverage(), /coverage/);
    } finally { await f.page.context().close(); }
  });

  await t.test('an interruption between admission and click survives guard replacement', async () => {
    const f = await fixture();
    try {
      await f.guard.admitBusinessJourneyStep({ phase: 'admit', journey: 'W4', step: 'move', deal, release });
      const restarted = stagingFixtureWriteGuard({ output, release, run });
      await assert.rejects(runBusinessJourneys({ page: f.page, fixtureGuard: restarted, release, deal, run }), /reconciliation/);
      assert.equal(f.writes.length, 0);
      assert.equal(await f.page.locator('#completionDialog').evaluate(node => node.open), false);
    } finally { await f.page.context().close(); }
  });

  await t.test('unsupported journey steps refuse before any request', async () => {
    const f = await fixture();
    try {
      for (const spec of [{ journey: 'W6', step: 'tour' }, { journey: 'W4', step: 'owner' }, { journey: 'W9', step: 'date', operation: 'send-mail' }])
        await assert.rejects(f.guard.admitBusinessJourneyStep({ phase: 'admit', deal, release, ...spec }), /journey-scope-unproved/);
      assert.equal(f.writes.length, 0);
    } finally { await f.page.context().close(); }
  });

  for (const missing of ['move', 'undo', 'date']) await t.test(`independent readback without ${missing} UI witness blocks canonical coverage and continuation`, async () => {
    const f = await fixture();
    try {
      const admit = f.guard.admitBusinessJourneyStep.bind(f.guard);
      f.guard.admitBusinessJourneyStep = async spec => {
        if (spec.phase !== 'observe' || spec.step !== missing) return admit(spec);
        const plan = JSON.parse(await readFile(planPath, 'utf8'));
        const row = plan.browser_write_attempts.find(row => row.journey.step === missing);
        assert.equal(row.state, 'acknowledged', 'the real UI request has an actual producer-shaped receipt');
        assert.equal(row.independent_readback.matched, true, 'the normal refresh has independently read the written effect');
        assert.equal(row.journey.state, 'admitted');
        assert.equal(row.journey.ui, undefined);
        assert.ok(spec.observation, 'the served app produced the rendered result before the synthetic interruption');
        await assert.rejects(assertStagingWriteCoverage(output), /write-coverage-incomplete/);
        await assert.rejects(f.guard.assertCoverage(), /write-coverage-incomplete/);
        await assert.rejects(f.scoped.assertCoverage(), /write-coverage-incomplete/);
        const continuation = f.guard.forContext();
        await assert.rejects(continuation.assertCoverage(), /write-coverage-incomplete/);
        await assert.rejects(continuation.admitControl({ identity: baseline.browser_control_proofs[0].identity }), /write-coverage-incomplete/);
        throw new Error('Synthetic interruption after real UI readback before witness');
      };
      await assert.rejects(runBusinessJourneys({ page: f.page, fixtureGuard: f.guard, release, deal, run }), /Synthetic interruption after real UI readback/);
      const count = f.writes.length;
      assert.equal(count, { move: 1, undo: 2, date: 3 }[missing]);
      const restarted = stagingFixtureWriteGuard({ output, release, run });
      await assert.rejects(restarted.admitBusinessJourneyStep({ phase: 'admit', journey: missing === 'date' ? 'W9' : 'W4', step: missing, deal, release }), /coverage|reconciliation/);
      if (new URL(f.page.url()).searchParams.get('deal') !== deal) {
        await f.page.goto(STAGING_ORIGIN + '/deals?deal=' + deal);
        await f.page.locator('#detailPhase').waitFor();
      }
      await assert.rejects(runBusinessJourneys({ page: f.page, fixtureGuard: restarted, release, deal, run }), /coverage|reconciliation/);
      await assert.rejects(assertStagingWriteCoverage(output), /write-coverage-incomplete/);
      assert.equal(f.writes.length, count, 'an acknowledged effect with a missing UI witness is never replayed');
    } finally { await f.page.context().close(); }
  });
});
