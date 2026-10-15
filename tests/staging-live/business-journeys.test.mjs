import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir, chmod, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, fixtureServer } from '../../test/browser-harness.mjs';
import { prepareStagingRecords, stagingFixtureWriteGuard, assertStagingWriteCoverage } from '../../scripts/e2e-staging/records.mjs';
import { runBusinessJourneys, runAutomaticPhaseUndo } from '../../scripts/e2e-staging/business-journeys.mjs';
import { qualifyV1Journeys } from '../../scripts/e2e-staging/v1-qualification.mjs';
import { openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import staging from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import businessJourneys from '../../contracts/e2e-staging-business-journeys.v1.json' with { type: 'json' };
import { fakeAPI } from './record-fixture.mjs';
import { admitFixtureRun } from './fixture-admission.mjs';
import { refuseFixtureCompanionConnection, assertCompanionUnavailable } from './companion-fixture.mjs';
import { COLUMNS } from '../../js/pipeline-model.js';

const release = { service: 'doctorcre-app', environment: 'staging', source_commit: '12181a8136e6e6030d5e8ed9dbeed6518ee258a4', carr_source_commit: staging.producer.source_commit };
const invoiceTarget = { project: { id: 'synthetic-staging-project', name: 'carr-staging-replacement-synthetic' }, branch: { id: 'synthetic-branch', name: 'main' }, endpoint: { id: 'ep-synthetic', host: 'ep-synthetic.neon.tech' }, database: 'neondb' };
function commissionID(run) {
  const bytes = createHash('sha1').update(Buffer.from('4acbfa5b1f3847afaac01c4688cfc479', 'hex')).update('staging-invoice-commission:' + run).digest().subarray(0, 16);
  bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const offsetDay = (value, days) => new Date(Date.parse(value.slice(0,10)) - days * 86_400_000).toISOString().slice(0,10);
const bodyResponse = (value, status = 200) => {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return { status: () => status, headers: () => ({ 'content-type': 'application/json' }), body: async () => body, json: async () => JSON.parse(body) };
};
const controlIdentityProbe = 'control-state.v1:' + '0'.repeat(64);

test('business journey exposes only the closed kebab-case failure code set', () => {
  assert.deepEqual(businessJourneys.error_codes, [
    'business-journey-receipt-missing',
    'business-journey-selector-unavailable',
    'business-journey-readback-incomplete',
    'business-journey-settlement-unverified'
  ]);
  assert.ok(businessJourneys.error_codes.every(code => /^[a-z][a-z0-9-]*$/.test(code)));
});

test('W15 awaiting contract binds normal deal receipts and fresh tracker and reconciliation reads', () => {
  const fixture = businessJourneys.source_bound_fixture_requests.find(row => row.id === 'W15_awaiting_invoice');
  assert.match(fixture.plan_binding, /normal new-deal, set-lead and patch-deal-field APIs/);
  assert.match(fixture.plan_binding, /No SQL installer or commission receipt is used for the awaiting deal/);
  assert.match(fixture.normal_reads, /read-invoice-tracker and read-deal-reconciliation/);
  assert.match(fixture.normal_reads, /before and after the UI observation/);
  assert.match(fixture.ui_proof, /perform no payment write for that row/);
  assert.ok(businessJourneys.unqualified_journeys.includes('W15'));
});

test('served board uses the admitted automatic event Undo once and observes the normal deal readback', { timeout: 90_000 }, async t => {
  admitFixtureRun(t);
  const output = await mkdtemp(join(tmpdir(), 'business-automatic-ui-'));
  const run = openRun(output, { runId: 'synthetic-automatic-ui', events: null });
  t.after(async () => { run.dispose(); await rm(output, { recursive: true, force: true }); });
  const api = fakeAPI(output, { sourceRelease: release });
  const setup = await prepareStagingRecords(output, { ...api, run });
  const fixtureRun = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8')).run;
  const deal = setup.records.deal.id, event = randomUUID(), undoEvent = randomUUID();
  const detail = { ...structuredClone(api.rows.deals.get(deal)), phase: 'research',
    phase_change: { automatic: true, event_id: event, phase: 'research', prior_phase: 'pending',
      reason: 'Fictional staging agent advanced an invented deal.', evidence_date: new Date().toISOString() },
    events: [{ id: event, verb: 'patch-deal-field', actor: 'joe-local', field: 'phase',
      old_value: { phase: 'pending' }, new_value: { phase: 'research' }, recorded_at: new Date().toISOString() }],
    critical_dates: [], thread: [], next_actions: [], activities: [], participants: [], premises: [],
    negotiation_rounds: [], documents: [] };
  const calls = [], server = await fixtureServer({ root: new URL('../../dist/site', import.meta.url).pathname });
  t.after(() => server.close());
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    let response;
    if (url.pathname === '/mcp') {
      const rpc = request.postDataJSON(), { name, arguments: args } = rpc.params;
      calls.push(name);
      let value;
      if (name === 'deal-room-board') value = { actor: 'joe', deals: [detail], unplaced_count: 0 };
      else if (name === 'get-deal-room') value = structuredClone(detail);
      else if (name === 'revert-deal-field') {
        assert.equal(args.event_id, event);
        detail.phase = 'pending'; detail.phase_change = { automatic: false, event_id: undoEvent };
        detail.events.push({ id: undoEvent, verb: 'revert-deal-field', actor: 'joe', field: 'phase',
          old_value: { phase: 'research' }, new_value: { phase: 'pending' }, recorded_at: new Date().toISOString() });
        value = { ok: true, deal_id: deal, field: 'phase', old_value: 'research', new_value: 'pending',
          reverted_event_id: event, event_id: undoEvent, event_recorded_at: new Date().toISOString() };
      } else value = { ok: true, items: [], notifications: [] };
      response = bodyResponse({ jsonrpc: '2.0', id: rpc.id,
        result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
    } else if (url.pathname === '/app-release') response = bodyResponse(release);
    else if (url.pathname === '/auth/session') response = bodyResponse({ actor: { slug: staging.session.actor_slug },
      e2e_principal: staging.session.e2e_principal });
    else if (url.pathname === '/pipeline/changes') response = bodyResponse({ events: [], presence: [], cursor: null, caught_up: true });
    else if (url.pathname.startsWith('/api/')) response = bodyResponse({ actor: { slug: 'joe' }, items: [], csrf_token: 'synthetic-only' });
    else {
      const served = await fetch(server.origin + url.pathname + url.search);
      const bytes = Buffer.from(await served.arrayBuffer());
      response = { status: () => served.status, headers: () => Object.fromEntries(served.headers),
        body: async () => bytes };
    }
    await route.fulfill({ status: response.status(), headers: response.headers(), body: await response.body() });
  });
  await page.goto(STAGING_ORIGIN + '/deals?deal=' + deal);
  const guardCalls = [], guard = { refusals: [], assertCoverage: async () => {},
    admitAutomaticPhaseUndo: async spec => {
      guardCalls.push(spec.phase);
      assert.equal(spec.deal, deal);
      if (spec.phase === 'admit') return { automatic_phase: { event_id: event, fixture_run: fixtureRun } };
      if (spec.phase === 'status') return { state: calls.includes('revert-deal-field') ? 'acknowledged' : 'admitted',
        independent_readback: { matched: true }, response: { binding: { effect: { event_id: undoEvent } } } };
      assert.deepEqual(spec.observation, { event_id: event, before_badge_visible: true,
        exact_undo_clicked: true, after_badge_absent: true, restored_phase: 'pending', undo_event_id: undoEvent });
      return { automatic_phase: { state: 'observed', fixture_run: fixtureRun,
        ui: { observation_sha256: 'a'.repeat(64) } },
        independent_readback: { matched: true, response_sha256: 'b'.repeat(64) } };
    } };
  const result = await runAutomaticPhaseUndo({ page, fixtureGuard: guard, release, deal, run });
  assert.equal(result.state, 'GENERIC_AUTOMATIC_UNDO_OBSERVED');
  assert.equal(result.doc_authorship_qualified, false);
  assert.deepEqual(result.actions.map(row => row.action), ['automatic-move', 'automatic-undo']);
  const qualified = qualifyV1Journeys({ sourcePair: release, runId: run.snapshot().id,
    fixtureRun, observations: result.actions });
  assert.equal(qualified.observed_actions, 2);
  assert.equal(calls.filter(name => name === 'revert-deal-field').length, 1);
  assert.deepEqual(guardCalls.filter(phase => phase !== 'status'), ['admit', 'observe']);
});

test('served signed-in app W4/W9 uses the real UI, canonical fixture guard and durable receipts', { timeout: 180_000 }, async t => {
  admitFixtureRun(t);
  const output = await mkdtemp(join(tmpdir(), 'business-journeys-'));
  const run = openRun(output, { runId: 'synthetic-business-journeys', events: null });
  t.after(async () => { run.dispose(); await rm(output, { recursive: true, force: true }); });
  const api = fakeAPI(output, { sourceRelease: release });
  const setup = await prepareStagingRecords(output, { ...api, run, awaitingInvoiceFixture: true });
  const planPath = join(output, 'staging-records-plan.json');
  const baseline = JSON.parse(await readFile(planPath, 'utf8'));
  assert.equal(baseline.receipts.awaiting_invoice_deal.deal_id, baseline.records.awaiting_invoice.deal_id);
  assert.equal(baseline.receipts.awaiting_invoice_lead.new_lead, 'joe');
  assert.equal(baseline.receipts.awaiting_invoice_close.deal_id, baseline.records.awaiting_invoice.deal_id);
  assert.ok(api.calls.some(call => call.path === '/mcp' && call.options.data.params.name === 'read-deal-reconciliation' &&
    call.options.data.params.arguments.deal === baseline.records.awaiting_invoice.deal_id));
  assert.ok(api.calls.some(call => call.path === '/mcp' && call.options.data.params.name === 'read-invoice-tracker'));
  const server = await fixtureServer({ root: new URL('../../dist/site', import.meta.url).pathname });
  t.after(() => server.close());
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
  t.after(() => browser.close());
  const deal = setup.records.deal.id;

  async function fixture({ lose = null, trust = invoiceTarget, mismatch = false } = {}) {
    await writeFile(planPath, JSON.stringify(baseline), { mode: 0o600 });
    const guard = stagingFixtureWriteGuard({ output, release, run, invoiceFixtureTarget: trust });
    const scoped = guard.forContext();
    const detail = { ...structuredClone(api.rows.deals.get(deal)), field_base: {}, events: [], critical_dates: [], thread: [], next_actions: [], activities: [], participants: [], premises: [], negotiation_rounds: [], documents: [] };
    const invoiceDeal = setup.records.invoice.deal_id;
    const invoice = { ...structuredClone(api.rows.deals.get(invoiceDeal)), commission_id: commissionID(baseline.run), gross_amount: '1.00', status: 'invoiced', base_version: 1,
      closed_on: null, invoiced_on: null, commission_invoiced_on: offsetDay(baseline.observed_at,45), due_on: offsetDay(baseline.observed_at,15), received_on: null, as_of: new Date().toISOString().slice(0,10), outcome: null };
    const otherInvoice = { ...invoice, deal_id: randomUUID(), commission_id: randomUUID(), owner: 'dell', name: 'Synthetic other owner invoice' };
    const awaitingInvoice = { ...invoice, deal_id: baseline.records.awaiting_invoice.deal_id, commission_id: null, status: null, owner: 'joe',
      name: baseline.records.awaiting_invoice.name, invoiced_on: null,
      gross_amount: null, commission_invoiced_on: null, due_on: null };
    const proof = { schema: 'doctorcre-staging-fixture-proof.v1', provenance: { kind: 'raw-sql-fixture' }, fixture_run: baseline.run, source_pair: baseline.release,
        recorded_plan_observed_at: baseline.observed_at, verified_target: invoiceTarget, tool_source_sha256: 'bc0d92b8c34e45f164514d7326ee0e1df7ce1eb936230c6eb89ffb4b69d52fdb',
      fixture: { mode: 'aged-invoice', date_offsets_days: { invoiced_on_before_observation:45, due_on_before_observation:15 }, observation_date: baseline.observed_at.slice(0,10),
        party: baseline.records.party, deal: { id: invoiceDeal, name: baseline.names.invoice, phase:'closed', outcome:null, owner:'joe', client_id: baseline.records.client.id },
        commission_id: invoice.commission_id, base_version:1,
        commission_readback: { id:invoice.commission_id, deal_id:invoiceDeal, gross_amount:'1.00', status:'invoiced', invoiced_on:invoice.commission_invoiced_on, received_on:null, base_version:1, due_on:invoice.due_on },
        tracker_readback: { deal_id:invoiceDeal, commission_id:invoice.commission_id, gross_amount:'1.00', status:'invoiced', invoiced_on:invoice.commission_invoiced_on, received_on:null, due_on:invoice.due_on } } };
    const proofDirectory = join(output,'installer-proof'); await mkdir(proofDirectory,{recursive:true,mode:0o700});
    const proofPath = join(proofDirectory,'invoice.json'); await writeFile(proofPath,JSON.stringify(proof),{mode:0o600});
    await chmod(proofPath,0o600);
    const writes = [], leases = [], reads = [], boardReads = [], changeEvents = [], denied = [], errors = [], admittedBeforeUI = [], readOnlyUI = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      try {
        const response = await scoped.handle(request, async () => {
          refuseFixtureCompanionConnection(request);
          if (url.pathname === '/mcp') {
            const rpc = request.postDataJSON(), { name, arguments: args } = rpc.params;
            const rpcReply = value => bodyResponse({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
            if (name === 'deal-room-board') {
              boardReads.push(structuredClone([detail]));
              return rpcReply({ actor: 'joe', deals: [detail], unplaced_count: 0 });
            }
            if (name === 'get-deal-room') { reads.push(args.deal); return rpcReply(structuredClone(detail)); }
            if (name === 'read-invoice-tracker') { reads.push('invoice'); return rpcReply({ schema_version:'invoice-tracker.v1', actor:'joe', observed_at:new Date().toISOString(), entries:[{...invoice,...(mismatch?{commission_id:randomUUID()}: {})}, otherInvoice, awaitingInvoice] }); }
            if (name === 'presence-lease') { leases.push(structuredClone(args)); return rpcReply({ ok: true,
              deal_id: args.deal, field: args.field, expires_at: new Date(Date.now() + 3000).toISOString() }); }
            if (name === 'record-commission-receipt') {
              const plan = JSON.parse(await readFile(planPath,'utf8'));
              const row = plan.browser_write_attempts.find(row=>row.arguments.idempotency_key===args.idempotency_key);
              assert.equal(row.state,'inflight'); assert.equal(row.journey.id,'W15');
              assert.equal(plan.fixture_proofs.invoice.state,'ready');
              writes.push({name,args:structuredClone(args)});
              invoice.status='received'; invoice.received_on=args.received_on; invoice.base_version++;
              if (name===lose) throw new Error('Synthetic interrupted payment response');
              return rpcReply({ok:true,id:invoice.commission_id,base_version:invoice.base_version,received_on:invoice.received_on});
            }
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
                const event = { id: randomUUID(), recorded_at: new Date().toISOString(), actor: 'joe', verb: name,
                  field: 'phase', old_value: { phase: old }, new_value: { phase: next } };
                detail.phase = next;
                detail.field_base.phase = { event_id: event.id, recorded_at: event.recorded_at };
                detail.events.push(event);
                changeEvents.push({ ...event, subject_id: deal, subject_type: 'deal' });
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
          if (url.pathname === '/pipeline/changes') return bodyResponse({ events: structuredClone(changeEvents), presence: [], cursor: null, caught_up: true });
          if (url.pathname.startsWith('/api/')) return bodyResponse({ actor: { slug: 'joe' }, items: [], csrf_token: 'synthetic-only' });
          if (url.origin !== STAGING_ORIGIN) return bodyResponse('');
          const response = await fetch(server.origin + url.pathname + url.search);
          const bytes = Buffer.from(await response.arrayBuffer());
          return { status: () => response.status, headers: () => Object.fromEntries(response.headers), body: async () => bytes, json: async () => JSON.parse(bytes) };
        });
        await route.fulfill({ status: response.status(), headers: response.headers(), body: await response.body() });
      } catch (error) {
        if (!error.companionRead) denied.push(error.code || error.message);
        await route.abort();
      }
    });
    await page.goto(STAGING_ORIGIN + '/deals?deal=' + deal);
    await page.locator('#detailPhase').waitFor();
    await page.waitForFunction(() => document.querySelector('#callModeAvailability')?.textContent ===
      'Call recording runs on the Mac with Quill');
    await guard.assertCoverage();
    assertCompanionUnavailable(JSON.parse(await readFile(planPath, 'utf8')));
    const locator = page.locator.bind(page);
    page.locator = selector => {
      const actual = locator(selector);
      const action = selector === '#detailPhase' ? 'selectOption'
        : selector === '#completionConfirm' || selector === '#completionCancel' || selector === '#dealDateCancel' ||
          selector === '#dealDateForm button[type="submit"]' || selector === '#markInvoicePaid' || selector.startsWith('button[data-undo=') ? 'click' : null;
      if (action) {
        const perform = actual[action].bind(actual);
        actual[action] = async (...args) => {
          const cancel = selector === '#completionCancel' || selector === '#dealDateCancel';
          const beforeCancel = cancel ? writes.length : null;
          const plan = JSON.parse(await readFile(planPath, 'utf8'));
          const pending = plan.browser_write_attempts.filter(row => row.state === 'admitted');
          if (cancel) {
            assert.equal(pending.length, 1, 'cancel is tested against one durable admitted intent');
            assert.equal(pending[0].dispatched_outcome, 'not dispatched');
            const result = await perform(...args);
            assert.equal(writes.length, beforeCancel, 'cancelling the UI dialog dispatches no mutation');
            return result;
          }
          assert.equal(pending.length, 1, 'one durable exact journey intent exists before touching the real UI');
          assert.equal(pending[0].journey.state, 'admitted');
          admittedBeforeUI.push(pending[0].operation);
          return perform(...args);
        };
      }
      if (['#allAges', '#clearInvoiceFilters', '#refreshInvoices', '#refreshHome',
        '[data-status="unpaid"]', '[data-status="awaiting"]', '[data-status="paid"]', '[data-scope="mine"]', '[data-scope="team"]'].includes(selector) ||
          selector.startsWith('#invoiceAging [data-age=')) {
        const perform = actual.click.bind(actual);
        actual.click = async (...args) => { readOnlyUI.push(selector); return perform(...args); };
      }
      return actual;
    };
    return { page, guard, scoped, detail, invoice, invoiceDeal, awaitingInvoice, awaitingDeal: awaitingInvoice.deal_id,
      proof, proofPath, writes, leases, reads, boardReads, changeEvents, denied, errors, admittedBeforeUI, readOnlyUI };
  }

  await t.test('phase change, event-specific undo and date all have UI results and independent reads', async () => {
    const f = await fixture();
    try {
      const result = await runBusinessJourneys({ page: f.page, fixtureGuard: f.guard, release, deal, run });
      assert.deepEqual(result.completed, ['W4', 'W9']);
      assert.equal(result.full_v1_qualified, false);
      assert.deepEqual(result.actions.map(row => [row.id, row.case, row.action]), [
        ['W4','local-deals','eight-columns'], ['W4','local-deals','drag-cancel'],
        ['W4','local-deals','drag-confirm'], ['W4','local-deals','independent-phase-readback'],
        ['W9','deal-timeline','recorded-phase-date'], ['W9','deal-timeline','date-dialog-cancel'],
        ['W9','deal-timeline','contract-date-write'], ['W9','deal-timeline','countdown'],
        ['W9','deal-timeline','date-control-removed']]);
      const qualified = qualifyV1Journeys({ sourcePair: release, runId: run.snapshot().id,
        fixtureRun: baseline.run, observations: result.actions });
      assert.equal(qualified.observed_actions, 9);
      assert.deepEqual(qualified.invalid, []);
      assert.ok(qualified.pending.some(row => row.id === 'W4' && row.action === 'automatic-move'));
      assert.ok(qualified.pending.some(row => row.id === 'W4' && row.action === 'automatic-undo'));
      assert.deepEqual(f.writes.map(row => row.name), ['patch-deal-field', 'revert-deal-field', 'add-critical-date']);
      assert.equal(f.leases.length, 2, 'cancel and retry each request one scoped drag presence lease');
      assert.ok(f.leases.every(lease => lease.deal === deal && lease.field === 'phase'));
      assert.equal(new Set(f.leases.map(lease => lease.idempotency_key)).size, 2);
      assert.deepEqual(f.admittedBeforeUI, ['patch-deal-field', 'revert-deal-field', 'add-critical-date']);
      assert.equal(COLUMNS.length, 8);
      assert.ok(f.boardReads.some(deals => deals.some(row => row.id === baseline.records.deal.id && row.phase === 'research')),
        'normal board read confirms the owned deal moved to the selected new column');
      assert.ok(f.boardReads.some(deals => deals.some(row => row.id === baseline.records.deal.id && row.phase === 'pending')),
        'normal board read confirms undo returned the owned deal to its source column');
      assert.ok(f.detail.events.every(event => !Object.hasOwn(event, 'subject_id') && !Object.hasOwn(event, 'subject_type')),
        'get-deal-room projects events under the enclosing deal identity');
      assert.ok(f.changeEvents.every(event => event.subject_id === deal && event.subject_type === 'deal'),
        'the separate change feed retains its subject identity');
      assert.equal(f.detail.phase, 'pending');
      assert.equal(f.detail.critical_dates.length, 1);
      const previousBoardReads = f.boardReads.length;
      if (await f.page.locator('#recordPanel').evaluate(node => node.open))
        await f.page.locator('#panelClose').click();
      await f.page.locator('#retryRead').click();
      for (let attempt = 0; f.boardReads.length === previousBoardReads && attempt < 100; attempt++)
        await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(f.boardReads.length > previousBoardReads, 'board card counts come from a fresh ordinary board read');
      const normalBoard = f.boardReads.at(-1);
      const expectedColumnCounts = Object.fromEntries(COLUMNS.map(column => [column.slug,
        normalBoard.filter(row => row.phase === column.slug).length]));
      const uiColumnCounts = await f.page.locator('.kanban-column').evaluateAll(nodes =>
        Object.fromEntries(nodes.map(node => [node.dataset.column, node.querySelectorAll('.kanban-card[data-id]').length])));
      assert.deepEqual(uiColumnCounts, expectedColumnCounts, 'rendered cards match the fresh authorized board read');
      const uiHeadingCounts = await f.page.locator('.kanban-column').evaluateAll(nodes =>
        Object.fromEntries(nodes.map(node => [node.dataset.column, Number(node.querySelector('h3 small')?.textContent)])));
      assert.deepEqual(uiHeadingCounts, expectedColumnCounts, 'all eight column headings match the fresh authorized board read');
      assert.equal(await f.page.locator('[data-add-date="rent_start"]').count(), 0, 'the added date control disappears');
      const plan = JSON.parse(await readFile(planPath, 'utf8'));
      assert.deepEqual(plan.browser_presence_leases.map(row => row.state), ['settled', 'settled']);
      assert.ok(plan.browser_presence_leases.every(row => row.response?.acknowledged === true &&
        row.response.receipt.deal_id === deal && row.response.receipt.field === 'phase'));
      for (const row of plan.browser_write_attempts) {
        assert.equal(row.state, 'acknowledged');
        assert.equal(row.journey.state, 'observed');
        assert.equal(row.independent_readback.matched, true);
        assert.equal(row.journey.ui.schema, 'staging-business-journey-ui.v1');
      }
      await assertStagingWriteCoverage(output);
      const count = f.writes.length;
      await f.page.goto(STAGING_ORIGIN + '/deals?deal=' + deal);
      await f.page.locator('#detailPhase').waitFor();
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

  await t.test('W9 date cancel and retry leave one observed date with independent readback', async () => {
    const f = await fixture();
    try {
      const retained = [];
      const result = await runBusinessJourneys({ page: f.page, fixtureGuard: f.guard, release, deal, run, journeys: ['W9'],
        onJourneyComplete: row => retained.push(row) });
      assert.deepEqual(result.completed, ['W9']);
      assert.equal(retained.length, 1);
      assert.deepEqual(retained[0].completed, ['W9']);
      assert.equal(retained[0].actions.length, 4);
      assert.deepEqual(result.actions.map(row => row.action),
        ['date-dialog-cancel','contract-date-write','countdown','date-control-removed']);
      assert.deepEqual(f.writes.map(row => row.name), ['add-critical-date']);
      assert.equal(f.detail.critical_dates.length, 1);
      const plan = JSON.parse(await readFile(planPath, 'utf8'));
      const row = plan.browser_write_attempts[0];
      assert.equal(row.state, 'acknowledged');
      assert.equal(row.journey.state, 'observed');
      assert.equal(row.independent_readback.matched, true);
      await assertStagingWriteCoverage(output);
    } finally { await f.page.context().close(); }
  });

  await t.test('interrupted dispatch is durable and rerun sends no second mutation', async () => {
    const f = await fixture({ lose: 'patch-deal-field' });
    try {
      await assert.rejects(runBusinessJourneys({ page: f.page, fixtureGuard: f.guard, release, deal, run, journeys: ['W4'] }),
        error => error.code === 'write-coverage-incomplete');
      assert.equal(f.writes.length, 1);
      const plan = JSON.parse(await readFile(planPath, 'utf8'));
      assert.ok(['inflight', 'unresolved'].includes(plan.browser_write_attempts[0].state));
      assert.equal(plan.browser_write_attempts[0].dispatched_outcome, 'unknown');
      const restarted = stagingFixtureWriteGuard({ output, release, run });
      await f.page.goto(STAGING_ORIGIN + '/deals?deal=' + deal);
      await f.page.locator('#detailPhase').waitFor();
      await assert.rejects(runBusinessJourneys({ page: f.page, fixtureGuard: restarted, release, deal, run, journeys: ['W4'] }),
        /unresolved|coverage|reconciliation|business-journey-settlement-unverified/);
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
        await assert.rejects(continuation.admitControl({ identity: controlIdentityProbe }), /write-coverage-incomplete/);
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

  await t.test('W15 hard-linked installer proof refuses before import and preserves journal and both names', async () => {
    const f=await fixture();
    try {
      const alias=f.proofPath+'.alias';
      const proofBytes=await readFile(f.proofPath), journalBytes=await readFile(planPath);
      await link(f.proofPath,alias);
      assert.equal((await stat(f.proofPath)).nlink,2,'the proof and alias are links to the same inode');
      await assert.rejects(f.guard.admitBusinessJourneyStep({phase:'import-fixture',journey:'W15',step:'paid',
        deal:f.invoiceDeal,release,proofPath:f.proofPath}),/proof|fixture/);
      assert.deepEqual(await readFile(planPath),journalBytes,'a rejected proof leaves the private journal byte-for-byte unchanged');
      assert.deepEqual(await readFile(f.proofPath),proofBytes,'the original name is unchanged');
      assert.deepEqual(await readFile(alias),proofBytes,'the hard-link alias is unchanged');
      assert.equal((await stat(f.proofPath)).nlink,2);
      assert.equal(f.writes.length,0);
    } finally {await f.page.context().close(); await rm(f.proofPath+'.alias',{force:true});}
  });

  await t.test('W15 real Home invoice link, marker receipt, independent tracker and fresh Home removal', async () => {
    const f=await fixture();
    try {
      await f.page.goto(STAGING_ORIGIN+'/');
      const result=await runBusinessJourneys({page:f.page,fixtureGuard:f.guard,release,deal:f.invoiceDeal,run,
        journeys:['W15'],invoiceProofPath:f.proofPath,awaitingInvoicePlan:baseline});
      assert.deepEqual(result.completed,['W15']); assert.equal(result.full_v1_qualified,false);
      assert.deepEqual(result.actions.map(row => [row.case,row.action]), [
        ['invoice-tracker','age-filter'], ['invoice-tracker','age-reset'],
        ['invoice-tracker','unpaid-detail'], ['invoice-tracker','payment-write'],
        ['invoice-tracker','paid-readback'], ['home-invoices','team-scope'],
        ['home-invoices','viewer-scope'], ['home-invoices','scope-reset'],
        ['home-invoices','payment-removal'], ['invoice-tracker','awaiting-payment-hidden']]);
      const qualified = qualifyV1Journeys({ sourcePair: release, runId: run.snapshot().id,
        fixtureRun: baseline.run, observations: result.actions });
      assert.equal(qualified.observed_actions,10);
      assert.deepEqual(qualified.invalid,[]);
      assert.ok(!qualified.pending.some(row => row.id === 'W15' && row.action === 'awaiting-payment-hidden'));
      assert.deepEqual(f.writes.map(row=>row.name),['record-commission-receipt']);
      assert.deepEqual(f.admittedBeforeUI,['record-commission-receipt']);
      const plan=JSON.parse(await readFile(planPath,'utf8'));
      assert.equal(plan.fixture_proofs.invoice.proof.fixture_run,baseline.run);
      assert.equal(plan.fixture_proofs.invoice.state,'quarantined');
      const row=plan.browser_write_attempts[0];
      assert.equal(row.independent_readback.operation,'read-invoice-tracker');
      assert.equal(row.journey.state,'observed'); assert.equal(row.response.receipt.event_id,undefined);
      assert.ok(f.readOnlyUI.includes('[data-status="unpaid"]'));
      assert.ok(f.readOnlyUI.includes('[data-status="awaiting"]'), 'the awaiting filter is checked against a separate synthetic normal read');
      assert.ok(f.readOnlyUI.includes('[data-status="paid"]'));
      assert.ok(f.readOnlyUI.some(selector => selector.startsWith('#invoiceAging [data-age=')));
      assert.ok(f.readOnlyUI.includes('#allAges') && f.readOnlyUI.includes('#clearInvoiceFilters'));
      assert.ok(f.readOnlyUI.filter(selector => selector === '[data-scope="mine"]').length >= 2);
      assert.ok(f.readOnlyUI.filter(selector => selector === '[data-scope="team"]').length >= 2);
      assert.equal(new URL(f.page.url()).searchParams.get('invoice'),'awaiting:'+f.awaitingDeal);
      await f.page.locator('#invoiceDetail').waitFor({state:'visible'});
      assert.equal(await f.page.locator('.invoice-status-value').textContent(),'Awaiting invoice');
      assert.equal(await f.page.locator('#invoicePayment').evaluate(node=>node.hidden),true);
      assert.equal(f.writes.length,1,'opening an awaiting row is read only');
      await assertStagingWriteCoverage(output);
      await rm(f.proofPath);
      await f.page.goto(STAGING_ORIGIN+'/');
      const copied = structuredClone(baseline);
      copied.run = randomUUID();
      copied.names.awaiting_invoice = `${copied.run} Synthetic W15 awaiting invoice`;
      copied.records.awaiting_invoice.name = copied.names.awaiting_invoice;
      copied.receipts.awaiting_invoice_deal.name = copied.names.awaiting_invoice;
      await assert.rejects(runBusinessJourneys({page:f.page,fixtureGuard:f.guard,release,deal:f.invoiceDeal,run,
        journeys:['W15'],awaitingInvoicePlan:copied}), error => error.code === 'business-journey-receipt-missing');
      assert.equal(new URL(f.page.url()).pathname,'/','foreign-run plan cannot reach the awaiting UI on resumed payment');
      assert.equal(f.writes.length,1,'foreign-run plan cannot repay a quarantined invoice');
      const resumed=await runBusinessJourneys({page:f.page,fixtureGuard:f.guard,release,deal:f.invoiceDeal,run,
        journeys:['W15'],awaitingInvoicePlan:baseline});
      assert.deepEqual(resumed.actions.map(row=>row.action),['awaiting-payment-hidden']);
      assert.equal(f.writes.length,1,'retained proof and paid quarantine never reseed or repay');
      f.invoice.due_on='2001-01-01';
      const spec={journey:'W15',step:'paid',deal:f.invoiceDeal,release};
      await f.guard.admitBusinessJourneyStep({...spec,phase:'fixture-refresh'});
      const reads=f.reads.length;
      await f.page.goto(STAGING_ORIGIN+'/');
      await f.page.locator('#refreshHome').click();
      await f.page.waitForFunction(()=>document.querySelector('#refreshHome')?.getAttribute('aria-busy')==='false');
      assert.ok(f.reads.length>reads,'the normal Home refresh actually requested independent tracker state');
      const changed=await f.guard.admitBusinessJourneyStep({...spec,phase:'fixture-status'});
      assert.equal(changed.state,'quarantined');
      assert.equal(changed.current_tracker_readback,undefined,'quarantine cannot turn a mismatched tracker row into fresh proof');
      assert.equal(f.writes.length,1);
    } finally {await f.page.context().close();}
  });

  await t.test('W15 awaiting action refuses missing, foreign and incomplete plan receipts before payment', async () => {
    const f = await fixture();
    try {
      await f.page.goto(STAGING_ORIGIN+'/');
      const copied = structuredClone(baseline);
      copied.run = randomUUID();
      copied.names.awaiting_invoice = `${copied.run} Synthetic W15 awaiting invoice`;
      copied.records.awaiting_invoice.name = copied.names.awaiting_invoice;
      copied.receipts.awaiting_invoice_deal.name = copied.names.awaiting_invoice;
      for (const changed of [
        { records: { ...baseline.records, awaiting_invoice: { ...baseline.records.awaiting_invoice, deal_id: randomUUID() } } },
        { release: { ...baseline.release, source_commit: 'b'.repeat(40) } },
        { receipts: { ...baseline.receipts, awaiting_invoice_close: { ...baseline.receipts.awaiting_invoice_close, event_id: randomUUID(), field: 'owner' } } },
        { receipts: { ...baseline.receipts, awaiting_invoice_lead: undefined } },
        { run: copied.run, names: copied.names, records: copied.records, receipts: copied.receipts },
        { observed_at: new Date(Date.parse(baseline.observed_at) + 1000).toISOString() },
      ]) {
        const plan = { ...baseline, ...changed };
        await assert.rejects(runBusinessJourneys({ page: f.page, fixtureGuard: f.guard, release,
          deal: f.invoiceDeal, run, journeys: ['W15'], invoiceProofPath: f.proofPath,
          awaitingInvoicePlan: plan }), error => error.code === 'business-journey-receipt-missing');
      }
      assert.equal(f.writes.length, 0);
      assert.equal(new URL(f.page.url()).pathname, '/', 'foreign-run and timestamp drift refuse before awaiting UI');
    } finally { await f.page.context().close(); }
  });

  await t.test('W15 awaiting action requires the exact normal tracker row after the paid receipt', async () => {
    const f = await fixture();
    try {
      f.awaitingInvoice.name = 'Wrong synthetic invoice';
      await f.page.goto(STAGING_ORIGIN+'/');
      await assert.rejects(runBusinessJourneys({ page: f.page, fixtureGuard: f.guard, release,
        deal: f.invoiceDeal, run, journeys: ['W15'], invoiceProofPath: f.proofPath,
        awaitingInvoicePlan: baseline }), error => error.code === 'business-journey-readback-incomplete' ||
          error.code === 'business-journey-selector-unavailable');
      assert.deepEqual(f.writes.map(row => row.name), ['record-commission-receipt']);
    } finally { await f.page.context().close(); }
  });

  await t.test('W15 invalid or untrusted installer proof and copied proof without CARR row cannot admit a write', async () => {
    for (const kind of ['tool','run','source','target','commission','receipt','permissions','untrusted','copied']) {
      const f=await fixture({trust:kind==='untrusted'?null:invoiceTarget,mismatch:kind==='copied'});
      try {
        const proof=structuredClone(f.proof);
        if(kind==='tool')proof.tool_source_sha256='215c7df7fa4fe5d133359d556e499809e0febc8cd6c3304d05f72831ea29508c';
        if(kind==='run')proof.fixture_run='different-fixture-run';
        if(kind==='source')proof.source_pair.source_commit='b'.repeat(40);
        if(kind==='target')proof.verified_target.endpoint.id='ep-other';
        if(kind==='commission')proof.fixture.commission_id=randomUUID();
        if(kind==='receipt') {const plan=structuredClone(baseline);plan.receipts.invoice_deal.deal_id=randomUUID();await writeFile(planPath,JSON.stringify(plan),{mode:0o600});}
        await writeFile(f.proofPath,JSON.stringify(proof),{mode:0o600});
        if(kind==='permissions')await chmod(f.proofPath,0o644);
        if(kind==='copied') {
          const spec={journey:'W15',step:'paid',deal:f.invoiceDeal,release};
          await f.guard.admitBusinessJourneyStep({...spec,phase:'import-fixture',proofPath:f.proofPath});
          await f.page.goto(STAGING_ORIGIN+'/');
          await f.page.locator('#refreshHome').click();
          for(let i=0;i<100;i++) {
            const value=await f.guard.admitBusinessJourneyStep({...spec,phase:'fixture-status'});
            if(value.state==='unavailable')break;
            if(i===99)assert.fail('copied proof did not reach the independent mismatch');
            await new Promise(resolve=>setTimeout(resolve,25));
          }
          await assert.rejects(f.guard.admitBusinessJourneyStep({...spec,phase:'admit',received_on:f.invoice.as_of,
            before_observation:{commission_id:f.invoice.commission_id,home_attention_present:true}}),/readback/);
        } else await assert.rejects(f.guard.admitBusinessJourneyStep({phase:'import-fixture',journey:'W15',step:'paid',deal:f.invoiceDeal,release,proofPath:f.proofPath}),/fixture|proof|source|target|receipt/);
        assert.equal(f.writes.length,0);
      } finally {await f.page.context().close();}
    }
  });

  await t.test('W15 proof plus current CARR row grants no marker without an admitted journey intent',async()=>{
    const f=await fixture();
    try {
      const spec={journey:'W15',step:'paid',deal:f.invoiceDeal,release};
      await f.guard.admitBusinessJourneyStep({...spec,phase:'import-fixture',proofPath:f.proofPath});
      await f.page.goto(STAGING_ORIGIN+'/');
      await f.page.locator(`[data-home-key="invoice:${f.invoice.commission_id}"]`).waitFor();
      assert.equal((await f.guard.admitBusinessJourneyStep({...spec,phase:'fixture-status'})).state,'ready');
      await f.page.evaluate(async args=>{try{await fetch('/mcp',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:72,method:'tools/call',params:{name:'record-commission-receipt',arguments:args}})});}catch{}},
        {commission_id:f.invoice.commission_id,base_version:1,received_on:f.invoice.as_of,idempotency_key:randomUUID()});
      assert.equal(f.writes.length,0);assert.ok(f.denied.includes('journey-intent-missing'));
    }finally{await f.page.context().close();}
  });

  for(const interruption of ['lost-response','missing-ui'])await t.test(`W15 ${interruption} retains quarantine and refuses canonical coverage and replay`,async()=>{
    const f=await fixture({lose:interruption==='lost-response'?'record-commission-receipt':null});
    try {
      await f.page.goto(STAGING_ORIGIN+'/');
      let missingUIIntercepted = false;
      const phaseTrace = [];
      if(interruption==='missing-ui'){
        const admit=f.guard.admitBusinessJourneyStep.bind(f.guard);
        f.guard.admitBusinessJourneyStep=async spec=>{
          phaseTrace.push(`${spec.journey}:${spec.step}:${spec.phase}`);
          if(spec.journey==='W15'&&spec.phase==='observe'){
            missingUIIntercepted = true;
            const plan=JSON.parse(await readFile(planPath,'utf8')),row=plan.browser_write_attempts[0];
            assert.equal(row.state,'acknowledged');assert.equal(row.independent_readback.matched,true);
            assert.equal(plan.fixture_proofs.invoice.state,'quarantined');
            await assert.rejects(assertStagingWriteCoverage(output),/coverage/);
            await assert.rejects(f.guard.forContext().admitControl({identity:controlIdentityProbe}),/coverage/);
            throw new Error('Synthetic missing paid/Home UI witness');
          }
          return admit(spec);
        };
      }
      let failure;
      try { await runBusinessJourneys({page:f.page,fixtureGuard:f.guard,release,deal:f.invoiceDeal,run,journeys:['W15'],invoiceProofPath:f.proofPath}); }
      catch (error) { failure = error; }
      assert.ok(failure, 'the retained quarantine must refuse completion');
      if(interruption==='missing-ui') {
        const safeTrace=JSON.stringify({error:failure.message,phases:phaseTrace,
          uiActions:f.readOnlyUI,admittedOperations:f.admittedBeforeUI,writeCount:f.writes.length});
        assert.equal(missingUIIntercepted,true,`missing-UI injection was not reached: ${safeTrace}`);
        assert.equal(failure.message,'Synthetic missing paid/Home UI witness',
          `missing-UI scenario did not fail at its injected checkpoint: ${safeTrace}`);
        assert.ok(phaseTrace.includes('W15:paid:observe'));
      } else assert.match(failure.message,/coverage|reconciliation/);
      assert.equal(f.writes.length,1,failure.message);assert.equal(f.invoice.status,'received');
      const restarted=stagingFixtureWriteGuard({output,release,run,invoiceFixtureTarget:invoiceTarget});
      await assert.rejects(runBusinessJourneys({page:f.page,fixtureGuard:restarted,release,deal:f.invoiceDeal,run,journeys:['W15']}),/coverage|reconciliation/);
      assert.equal(f.writes.length,1);await assert.rejects(assertStagingWriteCoverage(output),/coverage/);
    }finally{await f.page.context().close();}
  });
});
