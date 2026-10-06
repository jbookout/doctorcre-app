import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, stat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStagingRecords } from '../../scripts/e2e-staging/records.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { eligibleLead } from '../../js/leads-model.js';

const fixture = 'fc08d2f4-a951-5679-9f34-40d0f4278842';
const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
const reply = body => ({ ok: () => true, status: () => 200, json: async () => body });
const envelope = body => reply({ result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });

function fakeAPI(output, { refuse, unknown, wrongParty = false, linkedLead = false, beforeReadback } = {}) {
  const calls = [], rows = { deals: new Map() };
  let disposed = 0;
  const id = number => `40000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const api = {
    async get(path, options) {
      calls.push({ path, options });
      if (path === '/auth/session') return reply({ actor: { slug: 'joe' }, e2e_principal: 'e2e-joe', csrf_token: 'private-csrf-canary' });
      if (path.startsWith('/api/v1/business/clients/')) { beforeReadback?.(rows); return reply({ record: { id: rows.client, name: rows.clientName ?? 'Synthetic Staging Fixture' } }); }
      if (path.startsWith('/api/tours/detail?')) return reply({ data: rows.tour });
      assert.fail(`Unexpected read ${path}`);
    },
    async post(path, options) {
      const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
      assert.equal((await stat(join(output, 'staging-records-plan.json'))).mode & 0o777, 0o600);
      calls.push({ path, options });
      const { name, arguments: args } = path === '/mcp' ? options.data.params : { name: 'tour', arguments: options.data };
      if (name !== 'get-deal-room' && name !== 'read-deal-reconciliation' && name !== 'lead-board' && name !== 'read-doc-conversation' && name !== 'read-invoice-tracker') {
        assert.ok(Object.values(plan.keys).includes(args.idempotency_key), 'write key is durable before request');
        assert.deepEqual(plan.inflight.arguments, args, 'exact mutation intent is durable before request');
      }
      if (name === unknown) throw new Error('private-provider-canary request secret');
      if (name === refuse) return reply({ result: { isError: true, content: [{ type: 'text', text: '{"error":"database_refused_the_statement","fault":"private-provider-canary"}' }] } });
      if (name === 'add-party') {
        if (args.name === 'Synthetic Staging Fixture') return envelope({ needs_confirm: true, candidates: [{ id: wrongParty ? id(99) : fixture, name: 'Synthetic Staging Fixture' }] });
        rows.leadParty = { id: id(6), name: args.name };
        return envelope({ ok: true, party_id: rows.leadParty.id });
      }
      if (name === 'new-client') { rows.client = id(1); return envelope({ ok: true, client_id: rows.client, ref: 'C-001' }); }
      if (name === 'new-deal') { const deal_id = id(rows.deals.size + 2); rows.deals.set(deal_id, { deal_id, id: deal_id, name: args.name, phase: 'pending', owner: null, lane: 'territory', base_version: 1, operating_state: 'active' }); return envelope({ ok: true, deal_id }); }
      if (name === 'get-deal-room') {
        const row = rows.deals.get(args.deal);
        const error = rows.roomError || (row?.phase === 'closed' ? { error: 'not_found', table: 'deal', id: args.deal } : null);
        if (error) return reply({ result: { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] } });
        return envelope(row);
      }
      if (name === 'read-deal-reconciliation') {
        if (rows.reconciliationError) return reply({ result: { isError: true, content: [{ type: 'text', text: JSON.stringify(rows.reconciliationError) }] } });
        const row = rows.deals.get(args.deal);
        return envelope(row && { id: row.id, name: row.name, phase: row.phase, base_version: row.base_version, lane: row.lane });
      }
      if (name === 'set-lead') { const row = rows.deals.get(args.deal); assert.equal(args.base_version, row.base_version); row.owner = 'joe'; row.base_version++; return envelope({ ok: true }); }
      if (name === 'update-deal') { const row = rows.deals.get(args.deal); assert.equal(args.base_version, row.base_version); row.phase = args.fields.phase; row.base_version++; return envelope({ ok: true }); }
      if (name === 'new-lead') { rows.lead = { id: id(4), stage: 'new', name: rows.leadParty?.name || 'Synthetic Staging Fixture', owner: 'joe', party_id: args.party_id, is_client: args.party_id === fixture, linked_client: linkedLead, is_deal: false, suppressed: false }; return envelope({ ok: true, lead_id: rows.lead.id, ref: 'L-001' }); }
      if (name === 'lead-board') return envelope({ detail: rows.lead });
      if (name === 'create-doc-conversation') { rows.conversation = { id: args.idempotency_key, title: args.title, visibility: 'private', archived_at: null }; return envelope({ ok: true, conversation_id: rows.conversation.id }); }
      if (name === 'read-doc-conversation') return envelope({ identity: rows.conversation });
      if (name === 'read-invoice-tracker') return envelope({ entries: [...rows.deals.values()].filter(row => row.phase === 'closed') });
      if (name === 'tour') { rows.tour = { id: id(5), name: args.tour_name, status: 'draft', subject_type: args.subject_type, subject_id: args.subject_id }; return reply({ data: { tour_id: rows.tour.id } }); }
      assert.fail(`Unexpected command ${name}`);
    },
    async dispose() { disposed++; },
  };
  const session = async () => ({ release, state: { cookies: [{ name: '__Host-dealroom_session', value: 'private-cookie-canary', secure: true, httpOnly: true }] } });
  const requestFactory = async options => { assert.equal(options.baseURL, STAGING_ORIGIN); return api; };
  return { session, requestFactory, calls, rows, disposed: () => disposed };
}

test('record setup rejects production origins before authentication, files or requests', async () => {
  for (const origin of ['https://app.doctorcre.com', 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev.evil.test', 'http://doctorcre-app-staging.joe-bookout-carr-us.workers.dev', 'https://user:canary@doctorcre-app-staging.joe-bookout-carr-us.workers.dev']) {
    await assert.rejects(prepareStagingRecords('/unused', {
      origin, session: () => assert.fail('must not authenticate'), requestFactory: () => assert.fail('must not request'),
    }), /exact.*staging origin/);
  }
});

test('normal staging APIs create representative records with private durable keys and receipts', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-records-'));
  try {
    const fake = fakeAPI(output);
    const result = await prepareStagingRecords(output, fake);
    assert.equal(result.complete, true);
    assert.deepEqual(result.release, release);
    assert.equal(result.records.party.id, fixture);
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
      assert.equal(plan.state, 'pending');
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
