import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { mkdtemp, readFile, writeFile, stat, rm, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStagingRecords as createStagingRecords, stagingFixtureWriteGuard as createFixtureWriteGuard, assertStagingWriteCoverage, parseStagingRPCReply } from '../../scripts/e2e-staging/records.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { eligibleLead } from '../../js/leads-model.js';

import { mkdtempSync } from 'node:fs';
import { openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { admitFixtureRun } from './fixture-admission.mjs';
beforeEach(admitFixtureRun);
const fixtureRuns = new Map(), temporaryRuns = [];
function fixtureBudget(root) {
  if (!fixtureRuns.has(root)) fixtureRuns.set(root, openRun(root, { runId: 'synthetic-fixture-run', events: null }));
  return fixtureRuns.get(root);
}
function prepareStagingRecords(output, options = {}) {
  return createStagingRecords(output, { run: fixtureBudget(output), ...options });
}
afterEach(async () => {
  for (const run of fixtureRuns.values()) run.dispose();
  fixtureRuns.clear();
  await Promise.all(temporaryRuns.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function stagingFixtureWriteGuard(options = {}) {
  const root = options.output || mkdtempSync(join(tmpdir(), 'staging-read-budget-'));
  if (!options.output) temporaryRuns.push(root);
  return createFixtureWriteGuard({ ...options, run: fixtureBudget(root) });
}

import { fixture, release, fakeAPI, reply, envelope } from './record-fixture.mjs';

test('staging RPC parser returns only fixed failure codes and response digests', () => {
  const errorEnvelopes = [
    [{ jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'private-provider-canary' } }, 'json-rpc-internal-error'],
    [{ jsonrpc: '2.0', id: 7, result: { isError: true, content: [{ type: 'text',
      text: JSON.stringify({ error: 'research_evidence_incomplete', detail: 'private-provider-canary' }) }] } }, 'research_evidence_incomplete'],
    [{ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text',
      text: JSON.stringify({ error: 'private-provider-canary', detail: 'private-provider-canary' }) }] } }, 'tool-error'],
  ];
  for (const [answer, code] of errorEnvelopes) {
    const parsed = parseStagingRPCReply(answer, 7);
    assert.equal(parsed.failure.code, code);
    assert.match(parsed.failure.response_sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(parsed.failure), /private-provider-canary|detail/);
  }
  const malformed = [
    null,
    { jsonrpc: '2.0', id: 8, result: { content: [{ type: 'text', text: '{"ok":true}' }] } },
    { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'private-provider-canary' }] } },
    { jsonrpc: '2.0', id: 7, result: { content: [] } },
  ];
  for (const answer of malformed) {
    const parsed = parseStagingRPCReply(answer, 7);
    assert.equal(parsed.failure.code, 'malformed-rpc-reply');
    assert.match(parsed.failure.response_sha256, /^[a-f0-9]{64}$/);
  }
  const success = { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: '{"ok":true}' }] } };
  assert.deepEqual(parseStagingRPCReply(success, 7), { value: { ok: true }, failure: null });
});

function interceptMCPReply(fake, output, operation, makeReply) {
  const requestFactory = async options => {
    const api = await fake.requestFactory(options);
    return { ...api, post: async (path, request) => {
      if (path !== '/mcp' || request.data?.params?.name !== operation) return api.post(path, request);
      const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
      assert.equal(plan.inflight.name, operation);
      assert.deepEqual(plan.inflight.arguments, request.data.params.arguments);
      fake.calls.push({ path, options: request });
      return reply(makeReply(request.data));
    } };
  };
  return { ...fake, requestFactory };
}

test('RPC error envelopes persist only closed codes and digests while retaining uncertain write intent', async t => {
  const cases = [
    ['json-rpc', request => ({ jsonrpc: '2.0', id: request.id,
      error: { code: -32603, message: 'private-provider-canary' } }), 'json-rpc-internal-error'],
    ['isError', request => ({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text',
      text: JSON.stringify({ error: 'research_evidence_incomplete', detail: 'private-provider-canary' }) }] } }), 'research_evidence_incomplete'],
    ['value-error', request => ({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text',
      text: JSON.stringify({ error: 'private-provider-canary', detail: 'private-provider-canary' }) }] } }), 'tool-error'],
    ['malformed', request => ({ jsonrpc: '2.0', id: request.id + 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }), 'malformed-rpc-reply'],
  ];
  for (const [kind, makeReply, code] of cases) await t.test(kind, async () => {
    const output = await mkdtemp(join(tmpdir(), 'staging-rpc-failure-'));
    try {
      const base = fakeAPI(output);
      await prepareStagingRecords(output, base);
      const failing = interceptMCPReply(fakeAPI(output), output, 'new-vendor', makeReply);
      await assert.rejects(prepareStagingRecords(output, { ...failing, reuseOnly: true, vendorFixture: true }), error => {
        assert.equal(error.code, 'staging-fixture-rpc-unresolved');
        assert.equal(error.message, 'Staging records setup stopped; partial plan requires reconciliation; no provider payload was logged');
        assert.doesNotMatch(error.message, /private-provider-canary/);
        return true;
      });
      const path = join(output, 'staging-records-plan.json');
      const plan = JSON.parse(await readFile(path, 'utf8'));
      const attempted = failing.calls.find(call => call.path === '/mcp' && call.options.data.params.name === 'new-vendor');
      const failure = plan.rpc_failures?.at(-1);
      assert.equal(plan.state, 'blocked');
      assert.equal(plan.inflight.name, 'new-vendor');
      assert.deepEqual(plan.inflight.arguments, attempted.options.data.params.arguments);
      assert.equal(plan.records.vendor, undefined);
      assert.equal(plan.receipts.vendor, undefined);
      assert.equal(failure.schema, 'doctorcre-staging-rpc-failure.v1');
      assert.equal(failure.step, 'vendor');
      assert.equal(failure.operation, 'new-vendor');
      assert.equal(failure.code, code);
      assert.equal(failure.request_sha256, createHash('sha256').update(JSON.stringify(plan.inflight.arguments)).digest('hex'));
      assert.equal(failure.response_sha256, createHash('sha256').update(JSON.stringify(makeReply(attempted.options.data))).digest('hex'));
      assert.doesNotMatch(JSON.stringify(plan), /private-provider-canary|detail/);
      const calls = failing.calls.length;
      await assert.rejects(prepareStagingRecords(output, { ...failing, reuseOnly: true, vendorFixture: true,
        session: () => assert.fail('uncertain RPC result must refuse before authentication') }), /partial plan requires reconciliation/);
      assert.equal(failing.calls.length, calls, 'quarantined plan issues no retry');
    } finally { await rm(output, { recursive: true, force: true }); }
  });
});

test('record setup rejects production origins before authentication, files or requests', async () => {
  for (const origin of ['https://app.doctorcre.com', 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev.evil.test', 'http://doctorcre-app-staging.joe-bookout-carr-us.workers.dev', 'https://user:canary@doctorcre-app-staging.joe-bookout-carr-us.workers.dev']) {
    await assert.rejects(createStagingRecords('/unused', {
      origin, session: () => assert.fail('must not authenticate'), requestFactory: () => assert.fail('must not request'),
    }), /exact.*staging origin/);
  }
});

test('resume reuse refuses missing, unsafe or unresolved setup before authentication', async t => {
  for (const kind of ['missing', 'pending', 'inflight', 'permissions', 'schema', 'origin']) await t.test(kind, async () => {
    const output = await mkdtemp(join(tmpdir(), 'staging-records-reuse-only-'));
    try {
      if (kind !== 'missing') {
        const plan = { schema: 'doctorcre-staging-records-plan.v1', origin: STAGING_ORIGIN, state: 'complete', release: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit } };
        if (kind === 'pending') plan.state = 'pending';
        if (kind === 'inflight') plan.inflight = { name: 'new-deal' };
        if (kind === 'schema') plan.schema = 'unexpected';
        if (kind === 'origin') plan.origin = 'https://app.doctorcre.com';
        await writeFile(join(output, 'staging-records-plan.json'), JSON.stringify(plan), { mode: kind === 'permissions' ? 0o644 : 0o600 });
      }
      let authenticated = 0;
      await assert.rejects(prepareStagingRecords(output, {
        reuseOnly: true,
        session: async () => { authenticated++; throw new Error('Synthetic authentication was reached'); },
        requestFactory: () => assert.fail('resume must not issue business requests'),
      }), /existing complete|partial plan|private regular/);
      assert.equal(authenticated, 0);
    } finally { await rm(output, { recursive: true, force: true }); }
  });
});

test('resume reuse reads existing synthetic records without repeating mutations', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-reuse-only-readback-'));
  try {
    const fake = fakeAPI(output);
    const first = await prepareStagingRecords(output, fake);
    fake.calls.length = 0;
    const reused = await prepareStagingRecords(output, { ...fake, reuseOnly: true });
    assert.deepEqual(reused.records, first.records);
    assert.deepEqual(fake.calls.filter(call => call.path === '/mcp').map(call => call.options.data.params.name), ['get-deal-room', 'read-deal-reconciliation', 'read-invoice-tracker', 'lead-board', 'read-doc-conversation']);
    assert.ok(fake.calls.every(call => call.path === '/mcp' || call.options.data === undefined));
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('W5 fixture extension records one owned vendor and original synthetic entry before normal readback', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-vendor-fixture-'));
  try {
    const fake = fakeAPI(output);
    await prepareStagingRecords(output, fake);
    fake.calls.length = 0;
    const extended = await prepareStagingRecords(output, { ...fake, reuseOnly: true, vendorFixture: true });
    assert.equal(extended.records.vendor.id, fake.rows.vendor.id);
    assert.equal(extended.records.vendor_entry.id, fake.rows.vendorEntry.id);
    const writes = fake.calls.filter(call => call.path === '/mcp' &&
      ['add-party', 'new-vendor', 'log-activity'].includes(call.options.data.params.name));
    assert.deepEqual(writes.map(call => call.options.data.params.name), ['add-party', 'new-vendor', 'log-activity']);
    assert.equal(writes[1].options.data.params.arguments.category, 'cpa');
    const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
    assert.equal(plan.receipts.vendor.vendor_id, extended.records.vendor.id);
    assert.equal(plan.receipts.vendor_entry.activity_id, extended.records.vendor_entry.id);
    assert.equal(writes[2].options.data.params.arguments.kind, 'note');
    assert.equal(writes[2].options.data.params.arguments.links[0].from_ref, extended.records.vendor.ref);
    assert.equal(writes[2].options.data.params.arguments.links[0].to_ref, extended.records.client.ref);
    fake.calls.length = 0;
    await prepareStagingRecords(output, { ...fake, reuseOnly: true, vendorFixture: true });
    assert.equal(fake.calls.filter(call => call.path === '/mcp' &&
      ['add-party', 'new-vendor', 'log-activity'].includes(call.options.data.params.name)).length, 0);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('W5 vendor taxonomy preflight refuses missing stage or category before any fixture mutation', async t => {
  for (const scenario of [
    { name: 'missing stage', options: { vendorStages: [] }, code: 'staging-fixture-stage-prerequisite' },
    { name: 'missing canonical category', options: { vendorCategories: [] }, code: 'staging-fixture-category-prerequisite' },
    { name: 'stale taxonomy', options: { vendorStages: [{ slug: 'prospect_uncontacted', label: 'Prospect' }], staleVendorTaxonomy: true }, code: 'staging-fixture-taxonomy-prerequisite' },
  ]) await t.test(scenario.name, async () => {
    const output = await mkdtemp(join(tmpdir(), 'staging-vendor-taxonomy-prerequisite-'));
    try {
      const fake = fakeAPI(output, scenario.options);
      await assert.rejects(prepareStagingRecords(output, { ...fake, vendorFixture: true }), error => {
        assert.equal(error.code, scenario.code);
        assert.equal(error.message, 'Staging vendor taxonomy prerequisite unavailable; no fixture mutation was attempted');
        return true;
      });
      assert.deepEqual(fake.calls.filter(call => call.path === '/mcp'), []);
      assert.ok(fake.calls.some(call => call.path === '/api/v1/business/vendors?contract=vendor-directory.v1'));
      await assert.rejects(readFile(join(output, 'staging-records-plan.json')));
    } finally { await rm(output, { recursive: true, force: true }); }
  });
});

test('W6 draft fixture adds a separately keyed Pensacola client and independently reads its actual receipt', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-w6-tour-client-'));
  try {
    const fake = fakeAPI(output);
    const base = await prepareStagingRecords(output, fake);
    const extended = await prepareStagingRecords(output, { ...fake, reuseOnly: true, tourDraftFixture: true });
    const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
    const writes = fake.calls.filter(call => call.path === '/mcp' &&
      ['add-party', 'new-client'].includes(call.options.data.params.name));
    const ownedWrites = writes.filter(call => call.options.data.params.arguments.name?.startsWith('QA Tour ') ||
      call.options.data.params.arguments.party_id === plan.records.tour_draft_party.id);
    assert.deepEqual(ownedWrites.map(call => call.options.data.params.name), ['add-party', 'new-client']);
    const [partyWrite, clientWrite] = ownedWrites.map(call => call.options.data.params.arguments);
    assert.equal(partyWrite.idempotency_key, plan.keys.tour_draft_party);
    assert.equal(clientWrite.idempotency_key, plan.keys.tour_draft_client);
    assert.equal(partyWrite.city, 'Pensacola'); assert.equal(partyWrite.state, 'FL');
    for (const args of [partyWrite, clientWrite]) assert.equal(Object.hasOwn(args, 'force_new'), false);
    assert.equal(clientWrite.party_id, plan.records.tour_draft_party.id);
    assert.deepEqual(clientWrite.research_evidence.field_evidence.city, [0]);
    assert.deepEqual(clientWrite.research_evidence.field_evidence.state, [0]);
    assert.notEqual(plan.records.tour_draft_party.id, base.records.party.id);
    assert.notEqual(plan.records.tour_draft_client.id, base.records.client.id);
    assert.equal(plan.receipts.tour_draft_party.party_id, plan.records.tour_draft_party.id);
    assert.equal(plan.receipts.tour_draft_client.client_id, plan.records.tour_draft_client.id);
    assert.equal(plan.records.tour_draft_party.city, 'Pensacola');
    assert.equal(plan.records.tour_draft_party.state, 'FL');
    assert.equal(extended.records.client.id, base.records.client.id);
    assert.equal(extended.records.party.id, base.records.party.id);
    assert.equal(plan.names.tour_draft_party, `QA Tour ${plan.keys.tour_draft_party}`);
    assert.equal(plan.names.tour_draft_client, plan.names.tour_draft_party);
    const independentRead = fake.calls.find(call => call.path === `/api/v1/business/clients/${plan.records.tour_draft_client.id}`);
    assert.ok(independentRead, 'dedicated client received a normal authenticated readback');
    fake.calls.length = 0;
    await prepareStagingRecords(output, { ...fake, reuseOnly: true, tourDraftFixture: true });
    assert.equal(fake.calls.filter(call => call.path === '/mcp' &&
      ['add-party', 'new-client'].includes(call.options.data.params.name)).length, 0);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('W6 fixture receipts without their durable record copies refuse before authentication or requests', async t => {
  for (const missing of ['tour_draft_party', 'tour_draft_client']) await t.test(missing, async () => {
    const output = await mkdtemp(join(tmpdir(), 'staging-w6-receipt-without-record-'));
    try {
      const fake = fakeAPI(output);
      await prepareStagingRecords(output, fake);
      await prepareStagingRecords(output, { ...fake, reuseOnly: true, tourDraftFixture: true });
      const path = join(output, 'staging-records-plan.json');
      const plan = JSON.parse(await readFile(path, 'utf8'));
      assert.ok(plan.receipts[missing]);
      delete plan.records[missing];
      await writeFile(path, JSON.stringify(plan), { mode: 0o600 });
      fake.calls.length = 0;
      await assert.rejects(prepareStagingRecords(output, { ...fake, reuseOnly: true, tourDraftFixture: true,
        session: () => assert.fail('interrupted fixture must refuse before authentication') }),
      /Tour draft client fixture partial plan requires reconciliation/);
      assert.equal(fake.calls.length, 0);
    } finally { await rm(output, { recursive: true, force: true }); }
  });
});

test('W15 controlled awaiting-invoice deal uses normal deal verbs and exact tracker/readback proof', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-w15-awaiting-invoice-'));
  try {
    const fake = fakeAPI(output);
    const base = await prepareStagingRecords(output, fake);
    fake.calls.length = 0;
    const extended = await prepareStagingRecords(output, { ...fake, reuseOnly: true, vendorFixture: true,
      tourDraftFixture: true, awaitingInvoiceFixture: true });
    const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
    const deal = plan.records.awaiting_invoice;
    assert.deepEqual(Object.keys(deal).sort(), ['deal_id', 'name']);
    assert.ok(deal.name.startsWith(plan.run));
    assert.notEqual(deal.deal_id, plan.records.invoice.deal_id);
    assert.equal(plan.records.client.id, base.records.client.id);
    assert.equal(plan.records.invoice.deal_id, base.records.invoice.deal_id);
    const writes = fake.calls.filter(call => call.path === '/mcp' &&
      ['new-deal', 'set-lead', 'patch-deal-field'].includes(call.options.data.params.name) &&
      ['awaiting_invoice_deal', 'awaiting_invoice_lead', 'awaiting_invoice_close']
        .some(step => call.options.data.params.arguments.idempotency_key === plan.keys[step]));
    assert.deepEqual(writes.map(call => call.options.data.params.name), ['new-deal', 'set-lead', 'patch-deal-field']);
    const [create, lead, close] = writes.map(call => call.options.data.params.arguments);
    assert.equal(create.client, plan.records.client.ref); assert.equal(create.phase, 'pending');
    assert.equal(create.idempotency_key, plan.keys.awaiting_invoice_deal);
    assert.equal(lead.deal, deal.deal_id); assert.equal(lead.new_lead, 'joe');
    assert.equal(lead.idempotency_key, plan.keys.awaiting_invoice_lead);
    assert.equal(close.deal, deal.deal_id); assert.equal(close.field, 'phase');
    assert.equal(close.value, 'closed'); assert.equal(close.idempotency_key, plan.keys.awaiting_invoice_close);
    assert.equal(Object.hasOwn(close, 'force_new'), false);
    assert.deepEqual(plan.receipts.awaiting_invoice_deal, { ok: true, deal_id: deal.deal_id,
      name: deal.name, client_ref: plan.records.client.ref });
    assert.deepEqual(plan.receipts.awaiting_invoice_lead, { ok: true, new_lead: 'joe' });
    assert.equal(plan.receipts.awaiting_invoice_close.ok, true);
    assert.equal(plan.receipts.awaiting_invoice_close.deal_id, deal.deal_id);
    assert.equal(plan.receipts.awaiting_invoice_close.field, 'phase');
    assert.match(plan.receipts.awaiting_invoice_close.event_id, /^[0-9a-f-]{36}$/i);
    assert.ok(fake.calls.some(call => call.path === '/mcp' && call.options.data.params.name === 'read-invoice-tracker'));
    assert.ok(fake.calls.some(call => call.path === '/mcp' && call.options.data.params.name === 'read-deal-reconciliation' &&
      call.options.data.params.arguments.deal === deal.deal_id));
    assert.ok(!fake.calls.some(call => call.path === '/mcp' && call.options.data.params.name === 'record-commission-receipt'));
    assert.ok(extended.records.awaiting_invoice);
    const receipts = structuredClone(plan.receipts);
    fake.calls.length = 0;
    await prepareStagingRecords(output, { ...fake, reuseOnly: true, awaitingInvoiceFixture: true });
    assert.deepEqual(JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8')).receipts, receipts);
    assert.equal(fake.calls.filter(call => call.path === '/mcp' &&
      ['new-deal', 'set-lead', 'patch-deal-field'].includes(call.options.data.params.name)).length, 0);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('W15 awaiting-invoice receipt, partial plan, and tracker mismatches refuse without replay', async t => {
  for (const kind of ['wrong-receipt', 'partial-receipts', 'missing-row', 'commission-row']) await t.test(kind, async () => {
    const output = await mkdtemp(join(tmpdir(), 'staging-w15-awaiting-refusal-'));
    try {
      const fake = fakeAPI(output, {
        awaitingInvoiceReceipt: kind === 'wrong-receipt' ? 'wrong-name' : undefined,
        awaitingInvoiceTracker: kind === 'missing-row' ? 'missing' : kind === 'commission-row' ? 'invoiced' : undefined,
      });
      await prepareStagingRecords(output, fake);
      if (kind === 'wrong-receipt') {
        await assert.rejects(prepareStagingRecords(output, { ...fake, reuseOnly: true, awaitingInvoiceFixture: true }),
          /stopped at awaiting_invoice_deal/);
        const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
        assert.equal(plan.records.awaiting_invoice, undefined);
        assert.equal(plan.inflight.name, 'new-deal');
        const attempted = fake.calls.filter(call => call.path === '/mcp' && call.options.data.params.name === 'new-deal').length;
        await assert.rejects(prepareStagingRecords(output, { session: () => assert.fail('must not replay uncertain create') }),
          /partial plan requires reconciliation/);
        assert.equal(fake.calls.filter(call => call.path === '/mcp' && call.options.data.params.name === 'new-deal').length, attempted);
      } else {
        if (kind === 'partial-receipts') {
          const path = join(output, 'staging-records-plan.json');
          await prepareStagingRecords(output, { ...fake, reuseOnly: true, awaitingInvoiceFixture: true });
          const plan = JSON.parse(await readFile(path, 'utf8'));
          delete plan.receipts.awaiting_invoice_lead;
          await writeFile(path, JSON.stringify(plan), { mode: 0o600 });
          fake.calls.length = 0;
          await assert.rejects(prepareStagingRecords(output, { ...fake, reuseOnly: true, awaitingInvoiceFixture: true,
            session: () => assert.fail('partial fixture must be refused before authentication') }),
          /awaiting-invoice fixture partial plan requires reconciliation/);
          assert.equal(fake.calls.length, 0);
        } else {
          await assert.rejects(prepareStagingRecords(output, { ...fake, reuseOnly: true, awaitingInvoiceFixture: true }),
            /stopped at readback/);
          const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
          assert.deepEqual(fake.calls.filter(call => call.path === '/mcp' &&
            ['awaiting_invoice_deal', 'awaiting_invoice_lead', 'awaiting_invoice_close']
              .some(step => call.options.data.params.arguments.idempotency_key === plan.keys[step]))
            .map(call => call.options.data.params.name), ['new-deal', 'set-lead', 'patch-deal-field']);
        }
      }
    } finally { await rm(output, { recursive: true, force: true }); }
  });
});

test('run-owned synthetic party names use distinct durable role keys before dispatch and retain normal dedup', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-party-identity-'));
  try {
    const fake = fakeAPI(output);
    await prepareStagingRecords(output, fake);
    await prepareStagingRecords(output, { ...fake, reuseOnly: true, vendorFixture: true });
    await prepareStagingRecords(output, { ...fake, reuseOnly: true, tourDraftFixture: true });
    const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
    const writes = fake.calls.filter(call => call.path === '/mcp' && call.options.data.params.name === 'add-party')
      .map(call => call.options.data.params.arguments);
    assert.equal(writes.length, 4);
    assert.equal(Object.hasOwn(writes[0], 'force_new'), false);
    for (const row of writes.slice(1)) {
      assert.equal(Object.hasOwn(row, 'force_new'), false);
      assert.equal(row.kind, 'org');
    }
    assert.equal(plan.names.lead, `QA Lead ${plan.keys.lead_party}`);
    assert.equal(plan.names.vendor, `QA Vendor ${plan.keys.vendor_party}`);
    assert.equal(plan.names.tour_draft_party, `QA Tour ${plan.keys.tour_draft_party}`);
    assert.deepEqual(writes.map(row => row.name), ['Synthetic Staging Fixture', plan.names.lead,
      plan.names.vendor, plan.names.tour_draft_party]);
    assert.equal(new Set(writes.map(row => row.name)).size, 4);
    assert.notEqual(plan.keys.lead_party, plan.keys.vendor_party);
    assert.notEqual(plan.keys.lead_party, plan.keys.tour_draft_party);
    assert.notEqual(plan.keys.vendor_party, plan.keys.tour_draft_party);
    const namesAndKeys = { names: plan.names, keys: plan.keys };
    fake.calls.length = 0;
    await prepareStagingRecords(output, { ...fake, reuseOnly: true, vendorFixture: true });
    await prepareStagingRecords(output, { ...fake, reuseOnly: true, tourDraftFixture: true });
    const resumed = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
    assert.deepEqual({ names: resumed.names, keys: resumed.keys }, namesAndKeys);
    assert.equal(fake.calls.filter(call => call.path === '/mcp' && call.options.data.params.name === 'add-party').length, 0);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('synthetic party candidate refusal retains bounded private evidence and cannot replay', async () => {
  for (const step of ['lead_party', 'vendor_party']) {
    const output = await mkdtemp(join(tmpdir(), 'staging-party-candidate-'));
    try {
      const initial = fakeAPI(output);
      if (step === 'vendor_party') await prepareStagingRecords(output, initial);
      const fake = fakeAPI(output, { candidateAt: step });
      const options = step === 'vendor_party' ? { reuseOnly: true, vendorFixture: true } : {};
      await assert.rejects(prepareStagingRecords(output, { ...fake, ...options }), /partial plan requires reconciliation/);
      const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
      assert.equal(plan.state, 'blocked');
      assert.equal(plan.inflight, null);
      assert.equal(Object.hasOwn(plan.receipts, step), false);
      assert.equal(plan.records[step], undefined);
      assert.equal(plan.refusals.length, 1);
      assert.equal(plan.refusals[0].step, step);
      assert.equal(plan.refusals[0].code, 'candidate-confirmation-required');
      assert.equal(plan.refusals[0].candidate_count, 1);
      assert.equal(plan.refusals[0].candidates[0].id, '40000000-0000-4000-8000-000000000099');
      assert.match(plan.refusals[0].response_sha256, /^[a-f0-9]{64}$/);
      assert.equal(fake.calls.filter(call => call.path === '/mcp' &&
        ['new-lead', 'new-vendor', 'log-activity'].includes(call.options.data.params.name)).length, 0);
      const count = fake.calls.length;
      await assert.rejects(prepareStagingRecords(output, { ...fake, ...options,
        session: () => assert.fail('blocked plan must refuse before auth') }), /partial plan requires reconciliation/);
      assert.equal(fake.calls.length, count);
    } finally { await rm(output, { recursive: true, force: true }); }
  }
});

test('W5 uncertain vendor producer leaves durable intent and refuses replay', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-vendor-uncertain-'));
  try {
    const fake = fakeAPI(output);
    await prepareStagingRecords(output, fake);
    const uncertain = fakeAPI(output, { unknown: 'new-vendor' });
    uncertain.rows.client = fake.rows.client;
    await assert.rejects(prepareStagingRecords(output, { ...uncertain, reuseOnly: true, vendorFixture: true }),
      /requires reconciliation/);
    const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
    assert.equal(plan.inflight.name, 'new-vendor');
    assert.equal(plan.inflight.arguments.idempotency_key, plan.keys.vendor);
    assert.equal(plan.records.vendor, undefined);
    await assert.rejects(prepareStagingRecords(output, { ...uncertain, reuseOnly: true, vendorFixture: true,
      session: () => assert.fail('uncertain effect must refuse before authentication') }), /requires reconciliation/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('normal staging APIs create representative records with private durable keys and receipts', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-'));
  try {
    const fake = fakeAPI(output);
    const result = await prepareStagingRecords(output, fake);
    assert.equal(result.complete, true);
    assert.deepEqual(result.release, release);
    assert.equal(result.records.party.id, fixture);
    const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
    assert.equal(plan.receipts.party, undefined, 'reuse must not fabricate an add-party creation receipt');
    assert.equal(plan.party_reuse.state, 'verified');
    assert.equal(plan.party_reuse.party_id, fixture);
    assert.equal(plan.party_reuse.client_id, result.records.client.id);
    assert.equal(plan.party_reuse.deal_id, result.records.deal.id);
    assert.match(plan.party_reuse.network_response_sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.records.client.id, fake.rows.client);
    assert.equal(result.records.deal.id, [...fake.rows.deals.keys()][0]);
    assert.equal(result.records.invoice.deal_id, [...fake.rows.deals.keys()][1]);
    assert.equal(result.records.lead.id, fake.rows.lead.id);
    assert.equal(eligibleLead(fake.rows.lead), true, 'the live workspace can expose lead stage/archive controls');
    assert.equal(result.records.conversation.id, fake.rows.conversation.id);
    assert.equal(result.records.tour.id, fake.rows.tour.id);
    const client = fake.calls.find(call => call.options?.data?.params?.name === 'new-client').options.data.params.arguments;
    assert.equal(client.status, 'engaged');
    assert.equal(client.acquisition_source, 'referral');
    assert.deepEqual(Object.keys(client.research_evidence.field_evidence).sort(), ['address', 'hours', 'phone', 'practice_name', 'practitioners', 'specialty']);
    assert.match(JSON.stringify(client.research_evidence), /synthetic/i);
    const tour = fake.calls.find(call => call.path === '/api/tours/create');
    assert.equal(tour.options.headers['x-carr-csrf'], 'private-csrf-canary');
    assert.deepEqual(Object.keys(tour.options.data.start_point).sort(), ['latitude', 'longitude', 'position_role', 'precision_class', 'source_ref']);
    for (const call of fake.calls) { assert.equal(call.options.maxRedirects, 0); assert.equal(call.options.headers.origin, STAGING_ORIGIN); }
    for (const file of ['staging-records-plan.json', 'staging-records.json']) {
      assert.equal((await stat(join(output, file))).mode & 0o777, 0o600);
      assert.doesNotMatch(await readFile(join(output, file), 'utf8'), /private-(cookie|csrf)-canary/);
    }
    assert.equal(fake.disposed(), 1);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('fixed-party reuse refuses a deal edge to a different party without replaying writes', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-party-lineage-'));
  try {
    const fake = fakeAPI(output, { wrongRelationship: true });
    await assert.rejects(prepareStagingRecords(output, fake), /stopped at readback/);
    const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
    assert.equal(plan.party_reuse.state, 'pending-readback');
    assert.equal(plan.receipts.party, undefined);
    const calls = fake.calls.length;
    await assert.rejects(prepareStagingRecords(output, { ...fake,
      session: () => assert.fail('unverified lineage must refuse before authentication') }), /partial plan requires reconciliation/);
    assert.equal(fake.calls.length, calls);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('uncertain or refused writes preserve the partial plan and cannot be blindly replayed', async () => {
  for (const failure of [{ refuse: 'new-client' }, { unknown: 'set-lead' }]) {
    const output = await mkdtemp(join(tmpdir(), 'staging-records-refusal-'));
    try {
      const fake = fakeAPI(output, failure);
      await assert.rejects(prepareStagingRecords(output, fake), error => {
        assert.match(error.message, /requires reconciliation/);
        assert.doesNotMatch(error.message, /private-provider-canary|fault|secret/);
        return true;
      });
      const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
      assert.equal(plan.state, failure.refuse ? 'blocked' : 'pending');
      if (failure.refuse) {
        assert.equal(plan.rpc_failures.at(-1).code, 'database_refused_the_statement');
        assert.match(plan.rpc_failures.at(-1).request_sha256, /^[a-f0-9]{64}$/);
        assert.match(plan.rpc_failures.at(-1).response_sha256, /^[a-f0-9]{64}$/);
        assert.doesNotMatch(JSON.stringify(plan.rpc_failures), /private-provider-canary|fault|secret/);
      }
      if (failure.unknown) assert.equal(plan.records.deal.id, [...fake.rows.deals.keys()][0], 'creation receipt survives a subsequent unknown handoff');
      assert.equal(plan.inflight.arguments.idempotency_key, plan.keys[plan.current_step]);
      const count = fake.calls.length;
      await assert.rejects(prepareStagingRecords(output, {
        session: () => assert.fail('partial setup must refuse before authentication'),
        requestFactory: () => assert.fail('partial setup must not reconnect'),
      }), /partial plan requires reconciliation/);
      assert.equal(fake.calls.length, count);
      assert.equal(fake.disposed(), 1);
    } finally { await rm(output, { recursive: true, force: true }); }
  }
});

test('unsafe private-plan permissions refuse before authentication; missing completed records never cause reseeding', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-readback-'));
  try {
    const fake = fakeAPI(output);
    const setup = await prepareStagingRecords(output, fake);
    const path = join(output, 'staging-records-plan.json');
    await chmod(path, 0o644);
    await assert.rejects(prepareStagingRecords(output, { session: () => assert.fail('must not authenticate') }), /private regular file/);
    await chmod(path, 0o600);
    fake.rows.deals.delete(setup.records.deal.id);
    fake.calls.length = 0;
    await assert.rejects(prepareStagingRecords(output, fake), /stopped at readback/);
    assert.ok(fake.calls.filter(call => call.path === '/mcp').every(call => call.options.data.params.name === 'get-deal-room'));
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('unexpected party candidates and production release identity refuse boundedly', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-identity-'));
  try {
    await assert.rejects(prepareStagingRecords(output, {
      session: async () => ({ state: {}, release: { ...release, environment: 'production' } }),
      requestFactory: () => assert.fail('must not create a request context'),
    }), /pinned staging source pair/);
    const fake = fakeAPI(output, { wrongParty: true });
    await assert.rejects(prepareStagingRecords(output, fake), /stopped at party/);
    const writes = fake.calls.filter(call => call.path === '/mcp').map(call => call.options.data.params);
    assert.deepEqual(writes.map(call => call.name), ['add-party']);
    assert.equal(Object.hasOwn(writes[0].arguments, 'force_new'), false);
    assert.equal(Object.hasOwn(writes[0].arguments, 'actor'), false);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('completed setup reads back and reuses records without repeating writes, exposing normal UI restores', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-reuse-'));
  try {
    const fake = fakeAPI(output);
    const first = await prepareStagingRecords(output, fake);
    fake.rows.deals.get(first.records.deal.id).operating_state = 'parked';
    fake.rows.lead.stage = 'archived';
    fake.rows.conversation.archived_at = '2026-10-06T00:00:00Z';
    fake.calls.length = 0;
    const reused = await prepareStagingRecords(output, fake);
    assert.deepEqual(reused.records, first.records);
    assert.deepEqual(reused.needs_restore.map(row => row.record), ['deal', 'lead', 'conversation']);
    const names = fake.calls.filter(call => call.path === '/mcp').map(call => call.options.data.params.name);
    assert.deepEqual(names, ['get-deal-room', 'read-deal-reconciliation', 'read-invoice-tracker', 'lead-board', 'read-doc-conversation']);
    assert.equal(fake.disposed(), 2);
    await assert.rejects(prepareStagingRecords(output, {
      ...fake, session: async () => ({ state: {}, release: { ...release, source_commit: 'b'.repeat(40) } }),
      requestFactory: () => assert.fail('source drift must refuse before request context'),
    }), /source pair/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('completed converted lead reports UI coverage limits with read-only guidance; identity loss still refuses', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-converted-'));
  try {
    const fake = fakeAPI(output);
    const first = await prepareStagingRecords(output, fake);
    assert.equal(first.eligibleLead, true);
    fake.rows.lead.linked_client = true;
    fake.rows.lead.client_id = first.records.client.id;
    fake.calls.length = 0;
    const refreshed = await prepareStagingRecords(output, fake);
    assert.deepEqual(refreshed.records, first.records);
    assert.equal(refreshed.eligibleLead, false);
    assert.deepEqual(refreshed.needs_restore.map(row => [row.record, row.reason, row.coverage_limited]), [['lead', 'ui_ineligible', true]]);
    assert.match(refreshed.needs_restore[0].guidance, /Create another invented lead through the normal UI/);
    assert.deepEqual(fake.calls.filter(call => call.path === '/mcp').map(call => call.options.data.params.name),
      ['get-deal-room', 'read-deal-reconciliation', 'read-invoice-tracker', 'lead-board', 'read-doc-conversation']);
    assert.deepEqual(JSON.parse(await readFile(join(output, 'staging-records.json'), 'utf8')), refreshed);
    fake.rows.lead.party_id = first.records.client.id;
    fake.calls.length = 0;
    await assert.rejects(prepareStagingRecords(output, fake), /stopped at readback/);
    assert.deepEqual(fake.calls.filter(call => call.path === '/mcp').map(call => call.options.data.params.name),
      ['get-deal-room', 'read-deal-reconciliation', 'read-invoice-tracker', 'lead-board']);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('fresh setup still refuses a lead that cannot expose Leads UI controls', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-ineligible-'));
  try {
    const fake = fakeAPI(output, { linkedLead: true });
    await assert.rejects(prepareStagingRecords(output, fake), /stopped at readback/);
    const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
    assert.equal(plan.state, 'pending');
    await assert.rejects(prepareStagingRecords(output, { session: () => assert.fail('must not authenticate') }), /partial plan requires reconciliation/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('completed setup reports mutable fixture changes as UI guidance without issuing business writes', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-lifecycle-'));
  try {
    const fake = fakeAPI(output);
    const first = await prepareStagingRecords(output, fake);
    fake.rows.clientName = 'Renamed invented staging client';
    const deal = fake.rows.deals.get(first.records.deal.id);
    Object.assign(deal, { name: 'Renamed invented staging deal', owner: 'dell', phase: 'active' });
    fake.rows.deals.get(first.records.invoice.deal_id).phase = 'pending';
    fake.rows.conversation.visibility = 'shared';
    fake.rows.tour.subject_id = first.records.lead_party.id;
    fake.calls.length = 0;
    const refreshed = await prepareStagingRecords(output, fake);
    assert.deepEqual(refreshed.records, first.records, 'owned IDs and original fixture names remain unchanged');
    assert.deepEqual(refreshed.needs_restore.map(row => [row.record, row.reason]), [
      ['client', 'name_changed'], ['deal', 'name_changed'], ['deal', 'owner_changed'],
      ['deal', 'phase_changed'], ['invoice', 'phase_changed'], ['conversation', 'visibility_changed'], ['tour', 'subject_changed'],
    ]);
    for (const row of refreshed.needs_restore) {
      assert.equal(row.coverage_limited, true);
      assert.match(row.guidance, /normal UI/);
    }
    assert.equal(refreshed.needs_restore.find(row => row.record === 'client').current_name, fake.rows.clientName);
    assert.equal(refreshed.needs_restore.find(row => row.reason === 'owner_changed').current_owner, 'dell');
    assert.deepEqual(fake.calls.filter(call => call.path === '/mcp').map(call => call.options.data.params.name),
      ['get-deal-room', 'read-deal-reconciliation', 'read-invoice-tracker', 'lead-board', 'read-doc-conversation']);
    assert.ok(fake.calls.every(call => call.path === '/mcp' || call.options.data === undefined));
    assert.deepEqual(JSON.parse(await readFile(join(output, 'staging-records.json'), 'utf8')), refreshed);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('fresh setup keeps mutable fixture proof strict and incomplete proof cannot be retried', async () => {
  const changes = [
    rows => { rows.clientName = 'Unexpected initial client name'; },
    rows => { [...rows.deals.values()][0].name = 'Unexpected initial deal name'; },
    rows => { [...rows.deals.values()][0].owner = 'dell'; },
    rows => { [...rows.deals.values()][0].phase = 'active'; },
    rows => { [...rows.deals.values()][0].phase = 'closed'; },
    rows => { [...rows.deals.values()][1].phase = 'pending'; },
    rows => { rows.conversation.visibility = 'shared'; },
    rows => { rows.tour.subject_id = rows.leadParty.id; },
  ];
  for (const beforeReadback of changes) {
    const output = await mkdtemp(join(tmpdir(), 'staging-records-fresh-proof-'));
    try {
      const fake = fakeAPI(output, { beforeReadback });
      await assert.rejects(prepareStagingRecords(output, fake), /stopped at readback/);
      const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
      assert.equal(plan.state, 'pending');
      await assert.rejects(prepareStagingRecords(output, { session: () => assert.fail('must not authenticate') }), /partial plan requires reconciliation/);
    } finally { await rm(output, { recursive: true, force: true }); }
  }
});

test('completed setup still refuses wrong, absent or malformed primary IDs without reseeding', async () => {
  const wrongID = '40000000-0000-4000-8000-000000000099';
  const changes = [
    rows => { rows.client = wrongID; },
    rows => { [...rows.deals.values()][0].deal_id = wrongID; },
    rows => { [...rows.deals.values()][1].id = wrongID; },
    rows => { rows.lead.id = wrongID; },
    rows => { rows.conversation.id = wrongID; },
    rows => { rows.tour.id = wrongID; },
    rows => { delete [...rows.deals.values()][0].deal_id; },
    rows => { rows.tour.id = 'malformed'; },
  ];
  for (const change of changes) {
    const output = await mkdtemp(join(tmpdir(), 'staging-records-primary-identity-'));
    try {
      const fake = fakeAPI(output);
      await prepareStagingRecords(output, fake);
      change(fake.rows);
      fake.calls.length = 0;
      await assert.rejects(prepareStagingRecords(output, fake), /stopped at readback/);
      assert.ok(fake.calls.filter(call => call.path === '/mcp').every(call =>
        ['get-deal-room', 'read-deal-reconciliation', 'read-invoice-tracker', 'lead-board', 'read-doc-conversation'].includes(call.options.data.params.name)));
      assert.ok(fake.calls.every(call => call.path === '/mcp' || call.options.data === undefined));
    } finally { await rm(output, { recursive: true, force: true }); }
  }
});

test('an unresolved intent refuses before authentication even if the plan claims complete', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-inflight-'));
  try {
    const fake = fakeAPI(output);
    await prepareStagingRecords(output, fake);
    const path = join(output, 'staging-records-plan.json');
    const plan = JSON.parse(await readFile(path, 'utf8'));
    plan.inflight = { name: 'set-lead', arguments: { idempotency_key: plan.keys.deal_lead } };
    await writeFile(path, JSON.stringify(plan));
    await assert.rejects(prepareStagingRecords(output, {
      session: () => assert.fail('must not authenticate unresolved intent'),
      requestFactory: () => assert.fail('must not reconnect unresolved intent'),
    }), /partial plan requires reconciliation/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('completed closed deal uses exact open-view not-found plus same-ID closed proof, without writes', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-closed-view-'));
  try {
    const fake = fakeAPI(output);
    const first = await prepareStagingRecords(output, fake);
    fake.rows.deals.get(first.records.deal.id).phase = 'closed';
    fake.calls.length = 0;
    const refreshed = await prepareStagingRecords(output, fake);
    assert.deepEqual(refreshed.records, first.records);
    assert.deepEqual(refreshed.needs_restore.map(row => [row.record, row.reason, row.coverage_limited]), [['deal', 'closed', true]]);
    assert.match(refreshed.needs_restore[0].guidance, /normal UI/);
    const calls = fake.calls.filter(call => call.path === '/mcp').map(call => call.options.data.params);
    assert.deepEqual(calls.map(call => call.name), ['get-deal-room', 'read-deal-reconciliation', 'read-deal-reconciliation', 'read-invoice-tracker', 'lead-board', 'read-doc-conversation']);
    assert.equal(calls[1].arguments.deal, first.records.deal.id);
    assert.ok(fake.calls.every(call => call.path === '/mcp' || call.options.data === undefined));
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('completed closed-view recovery refuses wrong not-found identity, nonclosed proof, missing IDs and API errors', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-closed-refusal-'));
  try {
    const fake = fakeAPI(output);
    const first = await prepareStagingRecords(output, fake);
    const deal = fake.rows.deals.get(first.records.deal.id);
    const exact = { error: 'not_found', table: 'deal', id: first.records.deal.id };
    const failures = [
      { room: { ...exact, id: first.records.invoice.deal_id }, calls: ['get-deal-room'] },
      { room: { error: 'not_found', table: 'deal' }, calls: ['get-deal-room'] },
      { room: { ...exact, table: 'client' }, calls: ['get-deal-room'] },
      { room: { error: 'unauthorized' }, calls: ['get-deal-room'] },
      { room: { error: 'database_refused_the_statement', fault: 'private-provider-canary' }, calls: ['get-deal-room'] },
      { room: exact, phase: 'pending', calls: ['get-deal-room', 'read-deal-reconciliation'] },
      { room: exact, id: first.records.invoice.deal_id, calls: ['get-deal-room', 'read-deal-reconciliation'] },
      { room: exact, id: null, calls: ['get-deal-room', 'read-deal-reconciliation'] },
      { room: exact, reconciliation: { error: 'not_found', table: 'deal', id: first.records.deal.id }, calls: ['get-deal-room', 'read-deal-reconciliation'] },
    ];
    for (const failure of failures) {
      fake.rows.roomError = failure.room;
      fake.rows.reconciliationError = failure.reconciliation;
      deal.id = Object.hasOwn(failure, 'id') ? failure.id : first.records.deal.id;
      deal.phase = failure.phase || 'closed';
      fake.calls.length = 0;
      await assert.rejects(prepareStagingRecords(output, fake), error => {
        assert.match(error.message, /stopped at readback/);
        assert.doesNotMatch(error.message, /private-provider-canary|fault|unauthorized/);
        return true;
      });
      assert.deepEqual(fake.calls.filter(call => call.path === '/mcp').map(call => call.options.data.params.name), failure.calls);
    }
  } finally { await rm(output, { recursive: true, force: true }); }
});

const browserKey = number => '50000000-0000-4000-8000-' + String(number).padStart(12, '0');
const browserRequest = (name, args = {}, { method = 'POST', path = '/mcp' } = {}) => ({
  method: () => method, url: () => STAGING_ORIGIN + path,
  postDataJSON: () => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
});
async function browserFixtures(t) {
  const output = await mkdtemp(join(tmpdir(), 'staging-browser-fixtures-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const setup = await prepareStagingRecords(output, fakeAPI(output));
  const path = join(output, 'staging-records-plan.json');
  const read = async () => JSON.parse(await readFile(path, 'utf8'));
  const write = plan => writeFile(path, JSON.stringify(plan), { mode: 0o600 });
  return { output, path, setup, read, write, guard: stagingFixtureWriteGuard({ output, release }) };
}
function operationReceipt(name, args, primary = args.deal || args.conversation_id || args.lead) {
  if (name === 'set-next-step') return { ok: true, deal_id: primary, next_step_id: browserKey(901),
    next_action_id: browserKey(902), supersedes: null, created_at: new Date().toISOString() };
  if (name === 'add-deal-note') return { ok: true, deal_id: primary, note_id: browserKey(903), created_at: new Date().toISOString() };
  if (name === 'rename-doc-conversation') return { ok: true, conversation_id: primary, version: args.base_version + 1,
    title: args.title || 'Fictional conversation', pinned: args.pinned ?? false, archived: args.archived ?? false };
  if (name === 'claim-lead') return { ok: true, lead_id: primary, owner: args.expected_actor };
  if (name === 'link-lead-client') return { ok: true, lead_id: primary, client_id: args.client_id };
  if (name === 'update-lead') return { ok: true, updated: ['stage'] }; // Actual pinned response has no identity/value binding.
  assert.fail('Unknown synthetic operation');
}
const nextStep = (f, key = 1, text = 'Fictional next step') => ({
  deal: f.setup.records.deal.id, text, next_date: null, idempotency_key: browserKey(key),
});

test('the boot-time local companion GET is blocked without poisoning staging write coverage', async t => {
  const f = await browserFixtures(t);
  const request = { url: () => 'http://127.0.0.1:4682/api/state', method: () => 'GET' };
  await assert.rejects(f.guard.handle(request, () => assert.fail('local companion must never be contacted')),
    error => error.code === 'local-companion-read-blocked' && !error.fixturePolicy);
  assert.deepEqual(f.guard.refusals, []);
  await f.guard.assertCoverage();
  assert.equal((await f.read()).browser_write_refusals, undefined);
  for (const change of [
    { method: () => 'POST' }, { url: () => 'http://127.0.0.1:4682/api/state?token=private-canary' },
    { url: () => 'http://127.0.0.1:4682/api/start' }, { url: () => 'http://localhost:4682/api/state' },
  ]) await assert.rejects(f.guard.handle({ ...request, ...change }, () => assert.fail('unproved request must stay blocked')),
    error => error.code === 'origin-unproved' && error.fixturePolicy);
  assert.equal(f.guard.refusals.length, 4);
  await assert.rejects(f.guard.assertCoverage(), /write-coverage-incomplete/);
});

test('two measurement contexts per screen reuse verified static bytes while every staging fetch stays counted', async t => {
  const f = await browserFixtures(t);
  const manifest = JSON.parse(await readFile(new URL('../../dist/doctorcre-app.manifest.json', import.meta.url), 'utf8'));
  const assets = manifest.files.filter(row => /^(js|css)\//.test(row.path)).slice(0, 124);
  assert.equal(assets.length, 124);
  const data = new Map(await Promise.all(assets.map(async row => [row.path,
    await readFile(new URL('../../dist/site/' + row.path, import.meta.url))])));
  const load = async guard => {
    let forwarded = 0;
    for (let context = 0; context < 2; context++) {
      const scopedGuard = typeof guard === 'function' ? guard() : guard;
      for (const path of ['/', ...assets.map(row => '/' + row.path)]) {
        const bytes = data.get(path.slice(1)) || Buffer.from('<main>Fresh authenticated document</main>');
        const response = await scopedGuard.handle(browserRequest('unused', {}, { method: 'GET', path }), async () => {
          forwarded++;
          return { status: () => 200, headers: () => ({ 'content-type': 'text/plain', 'cache-control': 'no-cache' }), body: async () => bytes };
        });
        assert.deepEqual(await response.body(), bytes);
      }
    }
    return forwarded;
  };
  const before = await load(() => stagingFixtureWriteGuard({ output: f.output, release }));
  assert.equal(before, 250, 'cold per-screen inventory plus measurement contexts');
  const baseline = fixtureBudget(f.output).snapshot().httpRequests;
  const first = await load(f.guard), after = await load(f.guard);
  assert.equal(first, 126, '124 verified assets fetched once, plus two live documents');
  assert.equal(after, 2, 'warm screens still fetch both authenticated documents');
  assert.equal(fixtureBudget(f.output).snapshot().httpRequests - baseline, 128);
  t.diagnostic(`Requests per synthetic screen: uncached ${before}, initial verified-cache screen ${first}, warm ${after}`);
});

test('static replay refuses mismatched bytes, cookie responses, errors, HEAD and query variants', async t => {
  const f = await browserFixtures(t);
  const manifest = JSON.parse(await readFile(new URL('../../dist/doctorcre-app.manifest.json', import.meta.url), 'utf8'));
  const asset = manifest.files.find(row => row.path.startsWith('js/') && row.path.endsWith('.js'));
  const bytes = await readFile(new URL('../../dist/site/' + asset.path, import.meta.url));
  for (const scenario of ['mismatch', 'cookie', 'error', 'head', 'query']) {
    const guard = stagingFixtureWriteGuard({ output: f.output, release });
    let forwarded = 0;
    for (let i = 0; i < 2; i++) await guard.handle(browserRequest('unused', {}, {
      method: scenario === 'head' ? 'HEAD' : 'GET', path: '/' + asset.path + (scenario === 'query' ? '?v=other' : ''),
    }), async () => {
      forwarded++;
      return { status: () => scenario === 'error' ? 503 : 200,
        headers: () => scenario === 'cookie' ? { 'Set-Cookie': 'private-cookie-canary' } : {},
        body: async () => scenario === 'mismatch' ? Buffer.from('different staging source bytes') : bytes };
    });
    assert.equal(forwarded, 2, scenario);
  }
});

test('browser interception fulfills verified replay bytes and a stopped run cannot replay an asset', async t => {
  const { installStagingGuard } = await import('../../scripts/e2e-staging/engine.mjs');
  const f = await browserFixtures(t);
  const manifest = JSON.parse(await readFile(new URL('../../dist/doctorcre-app.manifest.json', import.meta.url), 'utf8'));
  const asset = manifest.files.find(row => row.path.startsWith('css/'));
  const bytes = await readFile(new URL('../../dist/site/' + asset.path, import.meta.url));
  const request = browserRequest('unused', {}, { method: 'GET', path: '/' + asset.path });
  let intercept, forwarded = 0;
  const fulfilled = [];
  await installStagingGuard({ route: async (_pattern, handle) => { intercept = handle; }, addInitScript: async () => {} }, f.guard);
  const route = { request: () => request, abort: async () => assert.fail('verified assets should be delivered'),
    fetch: async () => { forwarded++; return { status: () => 200,
      headers: () => ({ 'content-type': 'text/css', 'content-encoding': 'br', 'content-length': '1' }), body: async () => bytes }; },
    fulfill: async response => fulfilled.push(response),
  };
  await intercept(route); await intercept(route);
  assert.equal(forwarded, 1);
  assert.ok(fulfilled[0].response);
  assert.deepEqual(fulfilled[1], { status: 200, headers: { 'content-type': 'text/css' }, body: bytes });
  fixtureBudget(f.output).stop('stop-signal');
  await assert.rejects(f.guard.handle(request, () => assert.fail('stopped asset must not fetch')), /stop-signal/);
});

test('browser writes prove creation ownership and retain exact intent before a single dispatch', async t => {
  const f = await browserFixtures(t);
  let dispatches = 0;
  const args = nextStep(f);
  const response = await f.guard.handle(browserRequest('set-next-step', args), async () => {
    dispatches++;
    const plan = await f.read();
    assert.equal(plan.browser_write_attempts.length, 1);
    assert.deepEqual(plan.browser_write_attempts[0].arguments, args);
    assert.equal(plan.browser_write_attempts[0].state, 'inflight');
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    return envelope(operationReceipt('set-next-step', args));
  });
  assert.equal(response.status(), 200);
  const intent = (await f.read()).browser_write_attempts[0];
  assert.equal(intent.state, 'acknowledged');
  assert.match(intent.dispatched_outcome, /effect not independently verified/);
  assert.equal(dispatches, 1);
  for (const changed of [{ ...args, idempotency_key: browserKey(2) }, { ...args, text: 'Other text' }])
    await assert.rejects(f.guard.handle(browserRequest('set-next-step', changed), () => assert.fail('duplicate must not dispatch')), /duplicate-attempt/);
});

test('browser policy rejects nonfixture IDs, mixed references, globals and unreviewed shapes before dispatch', async t => {
  const f = await browserFixtures(t), external = browserKey(90);
  const lead = { lead: f.setup.records.lead.id, base_version: 1, expected_actor: 'joe', idempotency_key: browserKey(3) };
  const requests = [
    browserRequest('set-next-step', { ...nextStep(f), deal: external }),
    browserRequest('link-lead-client', { ...lead, client_id: external, confirmed: true }),
    browserRequest('update-lead', { ...lead, fields: { stage: 'new' }, stage_review: { reason: 'Fictional review', evidence_ids: [external] } }),
    browserRequest('rename-doc-conversation', { conversation_id: external, base_version: 1, pinned: true, idempotency_key: browserKey(4) }),
    browserRequest('set-next-step', { ...nextStep(f), party_id: f.setup.records.party.id }),
    browserRequest('claim-lead', { ...lead, expected_actor: 'another-actor' }),
    browserRequest('rename-doc-conversation', { conversation_id: f.setup.records.conversation.id, base_version: 1, pinned: 'true', idempotency_key: browserKey(4) }),
    browserRequest('set-notification-preference', { idempotency_key: browserKey(5) }),
    browserRequest('private-operation-name-canary', { secret: 'private-arguments-canary' }),
    browserRequest('__proto__', {}),
    ...['login', 'callback', 'reauth', 'logout', 'signout'].map(path =>
      browserRequest('unused', {}, { method: 'GET', path: '/auth/' + path })),
    browserRequest('set-next-step', nextStep(f), { path: '/api/tours/update' }),
    browserRequest('set-next-step', nextStep(f), { method: 'DELETE' }),
  ];
  for (const request of requests) await assert.rejects(f.guard.handle(request, () => assert.fail('scope refusal must precede dispatch')), /Staging fixture write refused/);
  const plan = await f.read();
  assert.equal(plan.browser_write_attempts, undefined);
  assert.equal(plan.browser_write_refusals.length, requests.length);
  assert.doesNotMatch(JSON.stringify(plan.browser_write_refusals), /private-operation-name-canary|private-arguments-canary|50000000|another-actor/);
});

test('missing or mismatched fixture provenance never dispatches, including forged ownership receipts', async t => {
  for (const kind of ['missing', 'receipt', 'source', 'inflight', 'permissions', 'schema', 'run', 'records', 'release']) await t.test(kind, async t => {
    const f = await browserFixtures(t), plan = await f.read();
    if (kind === 'missing') await rm(f.path);
    else {
      if (kind === 'receipt') plan.receipts.deal.deal_id = browserKey(90);
      if (kind === 'source') plan.release.source_commit = 'b'.repeat(40);
      if (kind === 'inflight') plan.inflight = { name: 'setup-write' };
      if (kind === 'schema') plan.schema = 'unexpected';
      if (kind === 'run') delete plan.run;
      if (kind === 'records') delete plan.records;
      if (kind === 'release') delete plan.release;
      await f.write(plan);
      if (kind === 'permissions') await chmod(f.path, 0o644);
    }
    await assert.rejects(f.guard.handle(browserRequest('set-next-step', nextStep(f)), () => assert.fail('missing provenance must not dispatch')), /refused/);
  });
});

test('intent storage failure stops dispatch and does not manufacture an acknowledgement', async t => {
  const f = await browserFixtures(t);
  const guard = stagingFixtureWriteGuard({ output: f.output, release, persist: async () => { throw new Error('private-storage-canary'); } });
  await assert.rejects(guard.handle(browserRequest('set-next-step', nextStep(f)), () => assert.fail('storage must precede dispatch')), /intent-or-provenance-unavailable/);
  assert.equal((await f.read()).browser_write_attempts, undefined);
  await assert.rejects(guard.assertCoverage(), /write-coverage-incomplete/);
  assert.doesNotMatch(JSON.stringify(guard.refusals), /private-storage-canary/);
});

test('interruption after dispatch and a restarted guard preserve one-attempt reconciliation', async t => {
  const f = await browserFixtures(t);
  let dispatches = 0;
  await assert.rejects(f.guard.handle(browserRequest('set-next-step', nextStep(f)), async () => {
    dispatches++;
    throw Object.assign(new Error('private-response-canary'), { code: 'private-error-code-canary' });
  }), /dispatch-outcome-unresolved/);
  assert.equal((await f.read()).browser_write_attempts[0].state, 'inflight');
  const restarted = stagingFixtureWriteGuard({ output: f.output, release });
  for (const [name, args] of [
    ['set-next-step', nextStep(f, 2)],
    ['add-deal-note', { deal: f.setup.records.deal.id, text: 'Other mutation', idempotency_key: browserKey(3) }],
  ]) await assert.rejects(restarted.handle(browserRequest(name, args), () => { dispatches++; }), /duplicate-attempt|ambiguous-record/);
  assert.equal(dispatches, 1);
  assert.doesNotMatch(JSON.stringify((await f.read()).browser_write_refusals), /private-response-canary|private-error-code-canary/);
});

test('ambiguous responses and post-dispatch storage failure cannot release a record for retry', async t => {
  for (const kind of ['unreadable', 'error', 'multiple-content', 'storage']) await t.test(kind, async t => {
    const f = await browserFixtures(t);
    const response = kind === 'unreadable' ? { status: () => 200, json: async () => { throw new Error('Unparsed'); } }
      : kind === 'error' ? envelope({ ok: false, error: 'refused' })
      : kind === 'multiple-content' ? reply({ result: { content: [{ type: 'text', text: '{"ok":true}' }, { type: 'text', text: '{"ok":false}' }] } })
      : envelope({ ok: true });
    let stored = 0;
    const guard = kind !== 'storage' ? f.guard : stagingFixtureWriteGuard({ output: f.output, release,
      persist: async (path, plan) => { if (++stored === 1) await f.write(plan); else throw new Error('Storage stopped'); },
    });
    if (kind === 'storage') await assert.rejects(guard.handle(browserRequest('set-next-step', nextStep(f)), async () => response));
    else await assert.rejects(guard.handle(browserRequest('set-next-step', nextStep(f)), async () => response), /dispatch-outcome-unresolved/);
    assert.equal((await f.read()).browser_write_attempts[0].state, kind === 'storage' ? 'inflight' : 'unresolved');
    await assert.rejects(stagingFixtureWriteGuard({ output: f.output, release }).handle(
      browserRequest('set-next-step', nextStep(f, 2)), () => assert.fail('ambiguous write cannot replay')), /duplicate-attempt/);
  });
});

test('concurrent same-record attempts dispatch only once while intent is unresolved', async t => {
  const f = await browserFixtures(t);
  let dispatched;
  const atDispatch = new Promise(resolve => { dispatched = resolve; });
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const first = f.guard.handle(browserRequest('set-next-step', nextStep(f)), async () => { dispatched(); await completion; return envelope(operationReceipt('set-next-step', nextStep(f))); });
  await atDispatch;
  await assert.rejects(f.guard.handle(browserRequest('add-deal-note', { deal: f.setup.records.deal.id, text: 'Another write', idempotency_key: browserKey(2) }),
    () => assert.fail('concurrent write must not dispatch')), /ambiguous-record/);
  complete();
  await first;
});

test('benign reads, including failed reads followed by retries, need no fixture writes or provenance', async () => {
  const guard = stagingFixtureWriteGuard();
  let reads = 0;
  // Every page mounts the Dr. CRE suggestion switch read; it must pass as a read.
  for (const request of [browserRequest('get-deal-room', { deal: 'read-only-external-record' }), browserRequest('lead-board'),
    browserRequest('list-feature-switches'),
    browserRequest('unused', {}, { method: 'GET', path: '/auth/session' }), browserRequest('unused', {}, { method: 'HEAD', path: '/' })]) {
    await assert.rejects(guard.handle(request, async () => { reads++; throw new Error('Read failed'); }), /Read failed/);
    const readResponse = reply({ read: 'succeeded' });
    assert.equal(await guard.handle(request, async () => { reads++; return readResponse; }), readResponse);
  }
  assert.equal(reads, 10);
  assert.deepEqual(guard.refusals, []);
  await guard.assertCoverage();
  await assert.rejects(guard.handle(browserRequest('claim-lead', { lead: browserKey(1), expected_actor: 'joe', base_version: 1, idempotency_key: browserKey(2) }),
    () => assert.fail('write without fixture plan cannot dispatch')), /fixture-provenance-missing/);
});

test('each admitted operation binds only creation-proved fixture records', async t => {
  const f = await browserFixtures(t), r = f.setup.records;
  const lead = { lead: r.lead.ref, base_version: 1, expected_actor: 'joe' };
  const operations = [
    ['add-deal-note', { deal: r.deal.id, text: 'Fictional note' }],
    ['set-next-step', { deal: r.invoice.deal_id, text: 'Fictional step', next_date: '2026-10-08' }],
    ['rename-doc-conversation', { conversation_id: r.conversation.id, base_version: 1, title: 'Fictional rename', pinned: true, archived: false }],
    ['claim-lead', lead],
    ['link-lead-client', { ...lead, client_id: r.client.id, confirmed: true }],
    ['update-lead', { ...lead, fields: { stage: 'new' }, stage_review: { reason: 'Fictional review', evidence_ids: [], human_quote: 'Reviewed' } }],
  ];
  for (const [index, [name, args]] of operations.entries()) {
    const requestArgs = { ...args, idempotency_key: browserKey(20 + index) };
    const result = f.guard.handle(browserRequest(name, requestArgs), async () =>
      envelope(operationReceipt(name, requestArgs, name.includes('lead') ? r.lead.id : args.deal || args.conversation_id)));
    if (name === 'update-lead') await assert.rejects(result, /dispatch-outcome-unresolved/);
    else await result;
  }
  const intents = (await f.read()).browser_write_attempts;
  assert.equal(intents.length, operations.length);
  assert.deepEqual(intents.at(-2).record_ids, [r.lead.id, r.client.id]);
  assert.ok(intents.slice(0, -1).every(row => row.state === 'acknowledged' && row.response.binding.operation === row.operation));
  assert.equal(intents.at(-1).state, 'unresolved', 'pinned stage receipt cannot prove record or changed value');
});

test('known GET/HEAD reads and exact static assets pass; unknown paths and auth mutations retain refusals before dispatch', async t => {
  const f = await browserFixtures(t);
  const known = ['/', '/calendar', '/auth/session', '/app-release', '/pipeline/changes',
    '/api/v1/business/clients/' + f.setup.records.client.id, '/api/tours/library', '/api/system-work/current', '/js/live-client.js', '/css/shell.css'];
  // Use a known stylesheet from the existing build manifest, not a made-up prefix grant.
  const manifest = JSON.parse(await readFile(new URL('../../dist/doctorcre-app.manifest.json', import.meta.url), 'utf8'));
  known[known.length - 1] = '/' + manifest.files.find(row => row.path.startsWith('css/')).path;
  let forwarded = 0;
  for (const method of ['GET', 'HEAD']) {
    for (const path of known) assert.equal((await f.guard.handle(browserRequest('unused', {}, { method, path }), async () => { forwarded++; return reply({ read: true }); })).status(), 200);
    for (const path of ['/auth/login', '/auth/callback', '/auth/reauth', '/auth/logout', '/api/system-work/challenge',
      '/api/system-work/WR-1/plan/accept', '/api/tours/create', '/api/v1/unknown-write', '/unknown-path', '/js/not-a-built-asset.js']) {
      await assert.rejects(f.guard.handle(browserRequest('unused', {}, { method, path }), () => assert.fail('unknown or auth GET must not dispatch')), /authentication-mutation-unproved|read-path-unproved/);
    }
  }
  assert.equal(forwarded, known.length * 2);
  const plan = await f.read();
  assert.equal(plan.browser_write_attempts, undefined);
  assert.equal(plan.browser_write_refusals.length, 20);
  assert.ok(plan.browser_write_refusals.every(row => row.forwarded === false));
});

test('wrong-record, incomplete and wrong-effect success responses remain unresolved and block later fingerprints', async t => {
  const names = ['set-next-step', 'add-deal-note', 'rename-doc-conversation', 'claim-lead', 'link-lead-client', 'update-lead'];
  for (const name of names) for (const failure of ['wrong-record', 'incomplete', 'wrong-effect']) await t.test(name + '/' + failure, async t => {
    const f = await browserFixtures(t), r = f.setup.records;
    const args = name === 'set-next-step' ? nextStep(f) :
      name === 'add-deal-note' ? { deal: r.deal.id, text: 'Fictional note', idempotency_key: browserKey(1) } :
      name === 'rename-doc-conversation' ? { conversation_id: r.conversation.id, base_version: 1, title: 'Fictional rename', pinned: true, idempotency_key: browserKey(1) } :
      { lead: r.lead.id, base_version: 1, expected_actor: 'joe', idempotency_key: browserKey(1),
        ...(name === 'link-lead-client' ? { client_id: r.client.id, confirmed: true } : {}),
        ...(name === 'update-lead' ? { fields: { stage: 'new' }, stage_review: { reason: 'Fictional review', evidence_ids: [] } } : {}) };
    const good = operationReceipt(name, args);
    const payload = failure === 'incomplete' ? { ok: true } : { ...good };
    if (failure === 'wrong-record') {
      if (name.includes('doc-conversation')) payload.conversation_id = browserKey(99);
      else if (name.includes('lead')) payload.lead_id = browserKey(99);
      else payload.deal_id = browserKey(99);
    }
    if (failure === 'wrong-effect') {
      if (name === 'set-next-step') payload.next_action_id = undefined;
      if (name === 'add-deal-note') payload.created_at = '2000-01-01T00:00:00Z';
      if (name === 'rename-doc-conversation') payload.pinned = false;
      if (name === 'claim-lead') payload.owner = 'another-actor';
      if (name === 'link-lead-client') payload.client_id = browserKey(99);
      if (name === 'update-lead') payload.updated = ['notes'];
    }
    let dispatches = 0;
    await assert.rejects(f.guard.handle(browserRequest(name, args), async () => { dispatches++; return envelope(payload); }), /dispatch-outcome-unresolved/);
    const stored = (await f.read()).browser_write_attempts[0];
    assert.equal(stored.state, 'unresolved');
    assert.equal(stored.response.acknowledged, false);
    assert.equal(stored.response.binding, undefined);
    // Change the fingerprint, not just the key; the unresolved record still blocks it.
    const laterName = name.includes('lead') ? 'link-lead-client' : name === 'rename-doc-conversation' ? name : 'add-deal-note';
    const later = laterName === 'link-lead-client' ? { lead: r.lead.id, base_version: 2, expected_actor: 'joe',
      client_id: r.client.id, confirmed: true, idempotency_key: browserKey(2) } :
      laterName === 'rename-doc-conversation' ? { conversation_id: r.conversation.id, base_version: 2, archived: true, idempotency_key: browserKey(2) } :
      { deal: r.deal.id, text: 'Distinct later action', idempotency_key: browserKey(2) };
    await assert.rejects(stagingFixtureWriteGuard({ output: f.output, release }).handle(browserRequest(laterName, later),
      () => { dispatches++; }), /ambiguous-record|duplicate-attempt/);
    assert.equal(dispatches, 1);
  });
});

test('receipt correlation, replay and future timestamps cannot release an ambiguous fixture', async t => {
  for (const kind of ['wrong-rpc-id', 'replayed', 'future']) await t.test(kind, async t => {
    const f = await browserFixtures(t), args = nextStep(f), payload = operationReceipt('set-next-step', args);
    if (kind === 'replayed') payload.replayed = true;
    if (kind === 'future') payload.created_at = '2999-01-01T00:00:00Z';
    const response = kind === 'wrong-rpc-id' ? reply({ jsonrpc: '2.0', id: 99, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }) : envelope(payload);
    await assert.rejects(f.guard.handle(browserRequest('set-next-step', args), async () => response), /dispatch-outcome-unresolved/);
    assert.equal((await f.read()).browser_write_attempts[0].state, 'unresolved');
  });
});

test('admitted read redirects retain a refusal while HTTP and transport failures preserve normal read handling', async t => {
  const f = await browserFixtures(t);
  for (const request of [
    browserRequest('unused', {}, { method: 'GET', path: '/app-release' }),
    browserRequest('unused', {}, { method: 'HEAD', path: '/app-release' }),
    browserRequest('get-deal-room', { deal: 'read-only-external-record' }),
  ]) {
    await assert.rejects(f.guard.handle(request, async () => ({ status: () => 302 })), /read-redirect-unproved/);
    await assert.rejects(f.guard.handle(request, async () => { throw new Error('Read connection interrupted'); }), /Read connection interrupted/);
    assert.equal((await f.guard.handle(request, async () => ({ status: () => 503 }))).status(), 503);
    assert.equal((await f.guard.handle(request, async () => ({ status: () => 200 }))).status(), 200);
  }
  const plan = await f.read();
  assert.equal(plan.browser_write_attempts, undefined);
  assert.equal(plan.browser_write_refusals.length, 3);
  assert.ok(plan.browser_write_refusals.every(row => row.reason === 'read-redirect-unproved' && row.forwarded));
});

test('producer-trimmed note and next-step text share a fingerprint while actual request evidence is retained', async t => {
  for (const name of ['add-deal-note', 'set-next-step']) await t.test(name, async t => {
    const f = await browserFixtures(t);
    const args = { deal: f.setup.records.deal.id, text: '  Same note  ', idempotency_key: browserKey(1),
      ...(name === 'set-next-step' ? { next_date: null } : {}) };
    await f.guard.handle(browserRequest(name, args), async () => envelope(operationReceipt(name, args)));
    assert.equal((await f.read()).browser_write_attempts[0].arguments.text, '  Same note  ');
    await assert.rejects(f.guard.handle(browserRequest(name, { ...args, text: 'Same note', idempotency_key: browserKey(2) }),
      () => assert.fail('whitespace-equivalent producer write cannot dispatch twice')), /duplicate-attempt/);
  });
});

test('conversation title remains exact in fingerprint, request evidence and receipt binding', async t => {
  const f = await browserFixtures(t);
  const args = { conversation_id: f.setup.records.conversation.id, base_version: 1,
    title: '  Exact title  ', idempotency_key: browserKey(1) };
  await f.guard.handle(browserRequest('rename-doc-conversation', args), async () => envelope(operationReceipt('rename-doc-conversation', args)));
  const second = { ...args, base_version: 2, title: 'Exact title', idempotency_key: browserKey(2) };
  await f.guard.handle(browserRequest('rename-doc-conversation', second), async () => envelope(operationReceipt('rename-doc-conversation', second)));
  const intents = (await f.read()).browser_write_attempts;
  assert.equal(intents[0].response.binding.effect.title, args.title);
  assert.notEqual(intents[0].fingerprint, intents[1].fingerprint, 'producer stores title verbatim');
  await f.guard.assertCoverage();
});

test('array-shaped receipt IDs, supersedes and timestamps stay unresolved and block different later writes', async t => {
  for (const [name, field] of [['set-next-step', 'next_step_id'], ['set-next-step', 'next_action_id'],
    ['set-next-step', 'supersedes'], ['set-next-step', 'created_at'], ['add-deal-note', 'note_id'], ['add-deal-note', 'created_at']])
    await t.test(name + '/' + field, async t => {
      const f = await browserFixtures(t), args = { ...nextStep(f), ...(name === 'add-deal-note' ? {} : {}) };
      if (name === 'add-deal-note') delete args.next_date;
      const payload = operationReceipt(name, args);
      payload[field] = [field === 'supersedes' ? browserKey(99) : payload[field]];
      await assert.rejects(f.guard.handle(browserRequest(name, args), async () => envelope(payload)), /dispatch-outcome-unresolved/);
      assert.equal((await f.read()).browser_write_attempts[0].state, 'unresolved');
      await assert.rejects(f.guard.handle(browserRequest('add-deal-note', {
        deal: args.deal, text: 'Different later note', idempotency_key: browserKey(2),
      }), () => assert.fail('malformed receipt must not release the record')), /ambiguous-record|duplicate-attempt/);
      await assert.rejects(stagingFixtureWriteGuard({ output: f.output, release }).assertCoverage(), /write-coverage-incomplete/);
    });
});

test('request keys and dates require their scalar contract types before intent or dispatch', async t => {
  const f = await browserFixtures(t);
  for (const key of [[browserKey(1)], { value: browserKey(1) }, null, 1])
    await assert.rejects(f.guard.handle(browserRequest('set-next-step', { ...nextStep(f), idempotency_key: key }),
      () => assert.fail('nonstring key cannot dispatch')), /operation-scope-unproved/);
  await assert.rejects(f.guard.handle(browserRequest('set-next-step', { ...nextStep(f), next_date: ['2026-10-08'] }),
    () => assert.fail('nonstring date cannot dispatch')), /operation-shape-unproved/);
  assert.equal((await f.read()).browser_write_attempts, undefined);
});

test('coverage waits for a pending write and restarted guards reject its durable inflight intent', async t => {
  const f = await browserFixtures(t);
  let began, finish;
  const atDispatch = new Promise(resolve => { began = resolve; });
  const responseReady = new Promise(resolve => { finish = resolve; });
  const writing = f.guard.handle(browserRequest('set-next-step', nextStep(f)), async () => {
    began(); await responseReady; return envelope(operationReceipt('set-next-step', nextStep(f)));
  });
  await atDispatch;
  await assert.rejects(stagingFixtureWriteGuard({ output: f.output, release }).assertCoverage(), /write-coverage-incomplete/);
  await assert.rejects(assertStagingWriteCoverage(f.output), /write-coverage-incomplete/);
  let coverageFinished = false;
  const checking = f.guard.assertCoverage({ timeoutMs: 5000 }).then(() => { coverageFinished = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(coverageFinished, false);
  finish(); await writing; await checking;
  assert.equal(coverageFinished, true);
  await stagingFixtureWriteGuard({ output: f.output, release }).assertCoverage();
  await assertStagingWriteCoverage(f.output);
});

test('bounded settlement timeout never becomes coverage success after a late complete receipt', async t => {
  const f = await browserFixtures(t);
  let began, finish;
  const atDispatch = new Promise(resolve => { began = resolve; });
  const responseReady = new Promise(resolve => { finish = resolve; });
  const writing = f.guard.handle(browserRequest('set-next-step', nextStep(f)), async () => {
    began(); await responseReady; return envelope(operationReceipt('set-next-step', nextStep(f)));
  });
  await atDispatch;
  await assert.rejects(f.guard.assertCoverage({ timeoutMs: 20 }), /dispatch-settlement-timeout/);
  finish();
  await assert.rejects(writing, /dispatch-outcome-unresolved/);
  const intent = (await f.read()).browser_write_attempts[0];
  assert.equal(intent.state, 'unresolved'); assert.equal(intent.coverage_timeout, true);
  await assert.rejects(stagingFixtureWriteGuard({ output: f.output, release }).assertCoverage(), /write-coverage-incomplete/);
  await assert.rejects(assertStagingWriteCoverage(f.output), /write-coverage-incomplete/);
});


test('fixture preparation checks cancellation before authentication and every mutation', async t => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-stop-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const stopped = new AbortController(); stopped.abort(new Error('synthetic-stop'));
  await assert.rejects(prepareStagingRecords(output, { signal: stopped.signal,
    session: async () => assert.fail('stopped setup authenticated'),
    requestFactory: async () => assert.fail('stopped setup requested'),
  }), /synthetic-stop/);
  const controller = new AbortController(), fake = fakeAPI(output);
  const factory = fake.requestFactory;
  const requestFactory = async options => {
    const api = await factory(options), post = api.post;
    api.post = async (...args) => { const response = await post.apply(api, args); controller.abort(new Error('synthetic-stop')); return response; };
    return api;
  };
  await assert.rejects(prepareStagingRecords(output, { ...fake, requestFactory, signal: controller.signal }), /synthetic-stop/);
  assert.equal(fake.calls.filter(row => row.path === '/mcp').length, 1, 'no mutation follows cancellation');
  assert.ok(fake.disposed() >= 1, 'active fixture request context is disposed');
});
