import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import journeys from '../../contracts/e2e-staging-business-journeys.v1.json' with { type: 'json' };
import { produceLocalAgentPhase, parseLocalAgentRpc, readLocalAgentTokenFile } from '../../scripts/e2e-staging/local-agent-phase.mjs';

const deal = '11111111-1111-4111-8111-111111111111';
const event = '22222222-2222-4222-8222-222222222222';
const manualMove = '55555555-5555-4555-8555-555555555555';
const manualUndo = '66666666-6666-4666-8666-666666666666';
const fixtureRun = '33333333-3333-4333-8333-333333333333';
const source = '4444444444444444444444444444444444444444';
const reason = 'Fictional staging agent advanced an invented deal for W4 badge and Undo verification.';
const pair = { source_commit: source, carr_source_commit: contract.producer.source_commit };
// Staging CARR runs a main commit newer than the contract floor.
const liveCarr = 'c'.repeat(40);
const release = { service: 'doctorcre-app', environment: 'staging', ...pair, carr_release_commit: liveCarr };
const syntheticSecurityIssue = (meta, uid) => meta.isFile && (meta.mode & 0o777) === 0o600 && meta.uid === uid
  ? null : 'unsafe';
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const manualRows = () => {
  const at = new Date().toISOString();
  const make = (step, args, receipt, effect, observation) => ({
    schema: 'staging-fixture-browser-intent.v1', operation: step === 'move' ? 'patch-deal-field' : 'revert-deal-field',
    record_ids: [deal], arguments: args, attempted_at: at, state: 'acknowledged',
    response: { acknowledged: true, receipt, binding: { operation: step === 'move' ? 'patch-deal-field' : 'revert-deal-field',
      record_ids: [deal], arguments_sha256: digest(args), effect } },
    independent_readback: { schema: 'staging-fixture-business-readback.v1', operation: 'get-deal-room',
      record_id: deal, matched: true, response_sha256: 'a'.repeat(64), observed_at: at },
    journey: { schema: 'staging-business-journey-step.v1', id: 'W4', step, fixture_run: fixtureRun,
      contract_sha256: digest(journeys), release: pair, admitted_at: at, state: 'observed',
      ui: { schema: 'staging-business-journey-ui.v1', observation_sha256: digest(observation), observed_at: at } },
  });
  const moveArgs = { deal, field: 'phase', value: 'research', base_event_id: null,
    idempotency_key: '77777777-7777-4777-8777-777777777777' };
  const moveReceipt = { ok: true, deal_id: deal, field: 'phase', old_value: 'pending',
    new_value: 'research', event_id: manualMove, event_recorded_at: at };
  const moveEffect = { field: 'phase', old_value: 'pending', new_value: 'research',
    event_id: manualMove, event_recorded_at: at };
  const undoArgs = { event_id: manualMove, idempotency_key: '88888888-8888-4888-8888-888888888888' };
  const undoReceipt = { ok: true, deal_id: deal, field: 'phase', reverted_event_id: manualMove,
    old_value: 'research', new_value: 'pending', event_id: manualUndo, event_recorded_at: at };
  const undoEffect = { field: 'phase', reverted_event_id: manualMove, prior_old_value: 'pending',
    old_value: 'research', new_value: 'pending', event_id: manualUndo, event_recorded_at: at };
  return [make('move', moveArgs, moveReceipt, moveEffect, { phase: 'research', event_id: manualMove }),
    make('undo', undoArgs, undoReceipt, undoEffect,
      { phase: 'pending', reverted_event_id: manualMove, badge: 'Undone' })];
};
const plan = () => ({ schema: 'doctorcre-staging-records-plan.v1', state: 'complete', inflight: null,
  origin: contract.origin, run: fixtureRun, release: pair,
  records: { deal: { id: deal, name: `Synthetic staging QA ${fixtureRun} active deal` },
    client: { ref: 'C-123' } }, receipts: { deal: { deal_id: deal } }, browser_write_attempts: manualRows() });
const before = () => ({ deal_id: deal, name: `Synthetic staging QA ${fixtureRun} active deal`,
  owner: 'joe', client_ref: 'C-123', phase: 'pending', phase_change: { event_id: manualUndo, automatic: false } });
const after = () => ({ ...before(), phase: 'research', phase_change: {
  event_id: event, automatic: true, prior_phase: 'pending', phase: 'research',
  reason, evidence_date: '2026-10-15T10:00:00Z' }, events: [{ id: event, actor: 'joe-local',
    verb: 'patch-deal-field', field: 'phase', old_value: { phase: 'pending' },
    new_value: { phase: 'research' } }] });
const board = later => ({ schema_version: 'local-deals-board.v1', actor: 'joe-local', deals: [{
  id: deal, name: before().name, owner: 'joe', client_ref: 'C-123',
  phase: later ? 'research' : 'pending', field_base: { phase: { id: later ? event : manualUndo } },
  phase_change: later ? after().phase_change : before().phase_change }] });
const activity = () => ({ schema_version: 'doc-activity.v1', entries: [{
  id: event, actor: 'Joe (local)', partner: 'joe', record: { id: deal }, why: reason,
  before: 'pending', after: 'research', undo: { event_id: event } }] });

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'w4-agent-fixture-'));
  await writeFile(join(root, 'staging-records-plan.json'), JSON.stringify(plan()), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldTarget = process.env.E2E_TARGET, oldSupervised = process.env.E2E_RUN_SUPERVISED;
  const oldOutput = process.env.E2E_V2_OUTPUT;
  process.env.E2E_TARGET = 'staging-live'; process.env.E2E_RUN_SUPERVISED = '1';
  process.env.E2E_V2_OUTPUT = root;
  t.after(() => {
    if (oldTarget === undefined) delete process.env.E2E_TARGET; else process.env.E2E_TARGET = oldTarget;
    if (oldSupervised === undefined) delete process.env.E2E_RUN_SUPERVISED;
    else process.env.E2E_RUN_SUPERVISED = oldSupervised;
    if (oldOutput === undefined) delete process.env.E2E_V2_OUTPUT;
    else process.env.E2E_V2_OUTPUT = oldOutput;
  });
  const calls = [];
  const run = { root, signal: new AbortController().signal, limits: { httpTimeoutMs: 1000 },
    check() {}, reserveBytes() {}, snapshot: () => ({ id: 'synthetic-run' }),
    http: async operation => operation() };
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'deal-room-board') return board(calls.filter(row => row.name === name).length > 1);
    if (name === 'get-deal-room') return calls.some(row => row.name === 'patch-deal-field') ? after() : before();
    if (name === 'read-doc-activity') return activity();
    if (name === 'patch-deal-field') return { ok: true, deal_id: deal, field: 'phase',
      old_value: 'pending', new_value: 'research', event_id: event,
      event_recorded_at: '2026-10-15T10:00:00Z' };
    throw Error('unexpected fake verb');
  };
  const releaseFetch = async url => ({ status: 200, url, json: async () => url.endsWith('/app-release')
    ? release : { env: { value: 'staging' }, git_sha: { value: liveCarr } } });
  return { run, rpc, releaseFetch, calls, root };
}

test('local credential file refuses FIFO, nonregular and oversized inputs before selection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'w4-agent-credential-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fifo = join(root, 'fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const moduleURL = new URL('../../scripts/e2e-staging/local-agent-phase.mjs', import.meta.url).href;
  const script = `import { readLocalAgentTokenFile } from ${JSON.stringify(moduleURL)};
    try { await readLocalAgentTokenFile(process.argv[1], () => null); process.exit(2); }
    catch (error) { process.exit(error.code === 'local-credential-file-unsafe' ? 0 : 3); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, fifo],
    { timeout: 2000, encoding: 'utf8' });
  assert.equal(child.status, 0, 'FIFO open must refuse without blocking');
  await assert.rejects(readLocalAgentTokenFile(root, syntheticSecurityIssue),
    { code: 'local-credential-file-unsafe' });
  const oversized = join(root, 'oversized');
  await writeFile(oversized, 'x'.repeat(64 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(readLocalAgentTokenFile(oversized, syntheticSecurityIssue),
    { code: 'local-credential-file-unsafe' });
  const regular = join(root, 'regular');
  await writeFile(regular, 'CARR_MCP_LOCAL_TOKEN=synthetic\n', { mode: 0o600 });
  assert.equal(await readLocalAgentTokenFile(regular, syntheticSecurityIssue),
    'CARR_MCP_LOCAL_TOKEN=synthetic\n');
});

test('failed parent directory durability stops before any agent network', async t => {
  const h = await harness(t);
  const original = fs.open;
  fs.open = async (path, ...args) => {
    const file = await original(path, ...args);
    if (path !== h.root) return file;
    return new Proxy(file, { get(target, key) {
      if (key === 'sync') return async () => { throw new Error('synthetic parent sync failure'); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(produceLocalAgentPhase({ plan: plan(), release, run: h.run,
      rpc: h.rpc, releaseFetch: h.releaseFetch }), /synthetic parent sync failure/);
    assert.equal(h.calls.length, 0);
  } finally { fs.open = original; syncBuiltinESMExports(); }
});

test('tampered FIFO private journal refuses before agent network', async t => {
  const h = await harness(t);
  await mkdir(join(h.root, 'private'), { mode: 0o700 });
  assert.equal(spawnSync('mkfifo', [join(h.root, 'private', 'w4-local-agent-phase.json')]).status, 0);
  await assert.rejects(produceLocalAgentPhase({ plan: plan(), release, run: h.run,
    rpc: h.rpc, releaseFetch: h.releaseFetch }), { code: 'journal-file-unsafe' });
  assert.equal(h.calls.length, 0);
});

test('journals before one normal agent patch, then proves canonical automatic event without Doc authorship', async t => {
  const h = await harness(t);
  const rpc = async (name, args, options) => {
    if (name === 'patch-deal-field') {
      const path = join(h.root, 'private', 'w4-local-agent-phase.json');
      const journal = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(journal.state, 'inflight');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(args.human_quote, undefined);
      assert.equal(args.change_reason, reason);
      assert.equal(args.base_event_id, manualUndo);
      assert.equal(options.timeout, 1000);
    }
    return h.rpc(name, args);
  };
  const result = await produceLocalAgentPhase({ plan: plan(), release, run: h.run, rpc,
    releaseFetch: h.releaseFetch });
  assert.equal(result.state, 'AUTOMATIC_SEAM_READY');
  assert.equal(result.doc_authorship_qualified, false);
  assert.equal(result.full_v1_qualified, false);
  assert.equal(JSON.stringify(result).includes(deal), false);
  assert.equal(JSON.stringify(result).includes(event), false);
  assert.deepEqual(h.calls.map(row => row.name), [
    'deal-room-board', 'get-deal-room', 'patch-deal-field', 'deal-room-board',
    'get-deal-room', 'read-doc-activity']);
  assert.equal(JSON.parse(await readFile(result.journal_path, 'utf8')).state, 'observed');
  await assert.rejects(produceLocalAgentPhase({ plan: plan(), release, run: h.run, rpc,
    releaseFetch: h.releaseFetch }),
    { code: 'agent-intent-already-exists' });
  assert.equal(h.calls.filter(row => row.name === 'patch-deal-field').length, 1);
});

test('wrong source or fixture receipt refuses before any network or journal', async t => {
  const h = await harness(t);
  for (const [p, r] of [
    [plan(), { ...release, carr_source_commit: '0'.repeat(40) }],
    [plan(), { ...release, carr_release_commit: undefined }],
    [{ ...plan(), origin: 'https://wrong.invalid' }, release],
    [{ ...plan(), receipts: { deal: { deal_id: event } } }, release],
    [{ ...plan(), records: { ...plan().records, deal: { id: deal, name: 'Other record' } } }, release],
  ]) await assert.rejects(produceLocalAgentPhase({ plan: p, release: r, run: h.run, rpc: h.rpc,
    releaseFetch: h.releaseFetch }),
    { code: 'agent-fixture-binding-refused' });
  assert.equal(h.calls.length, 0);
});

test('manual W4 must already have both observed receipts and independent reads before agent network', async t => {
  for (const kind of ['missing-undo', 'unobserved', 'missing-readback', 'foreign-event']) await t.test(kind, async t => {
    const h = await harness(t), path = join(h.root, 'staging-records-plan.json');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    if (kind === 'missing-undo') stored.browser_write_attempts.pop();
    if (kind === 'unobserved') stored.browser_write_attempts[1].journey.state = 'admitted';
    if (kind === 'missing-readback') delete stored.browser_write_attempts[1].independent_readback;
    if (kind === 'foreign-event') stored.browser_write_attempts[1].arguments.event_id = event;
    await writeFile(path, JSON.stringify(stored), { mode: 0o600 });
    await assert.rejects(produceLocalAgentPhase({ plan: plan(), release, run: h.run,
      rpc: h.rpc, releaseFetch: h.releaseFetch }), /write-coverage|manual-predecessor/);
    assert.equal(h.calls.length, 0, kind);
  });
});

test('RPC response ID mismatch is refused and a wrong-ID write stays quarantined', async t => {
  const envelope = id => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '{}'}] } });
  assert.deepEqual(parseLocalAgentRpc(envelope('expected'), 'expected'), {});
  assert.throws(() => parseLocalAgentRpc(envelope('other'), 'expected'), { code: 'agent-rpc-refused' });
  const h = await harness(t);
  let sent = 0;
  const rpc = async (name, args) => {
    if (name === 'patch-deal-field') {
      sent++;
      return parseLocalAgentRpc({ ...envelope('wrong'), result: { content: [{ type: 'text',
        text: JSON.stringify(await h.rpc(name, args)) }] } }, 'expected');
    }
    return h.rpc(name, args);
  };
  const result = await produceLocalAgentPhase({ plan: plan(), release, run: h.run, rpc,
    releaseFetch: h.releaseFetch });
  assert.equal(result.state, 'PENDING_RECONCILIATION');
  assert.equal(sent, 1);
  assert.equal(JSON.parse(await readFile(result.journal_path, 'utf8')).state, 'quarantined');
});

test('stale base and wrong owner refuse before patch', async t => {
  const h = await harness(t);
  for (const mutate of [row => { row.deals[0].owner = 'dell'; },
    row => { row.actor = 'dell-local'; },
    row => { row.deals[0].phase = 'research'; },
    row => { row.deals[0].field_base.phase.id = 'bad'; }]) {
    const rpc = async (name, args) => {
      if (name === 'deal-room-board') { const row = board(false); mutate(row); return row; }
      return h.rpc(name, args);
    };
    await assert.rejects(produceLocalAgentPhase({ plan: plan(), release, run: h.run, rpc,
      releaseFetch: h.releaseFetch }),
      { code: 'agent-fresh-base-refused' });
  }
  assert.equal(h.calls.some(row => row.name === 'patch-deal-field'), false);
});

test('redirect and wrong live source refuse before an intent or write', async t => {
  const h = await harness(t);
  for (const releaseFetch of [
    async url => ({ status: 302, url, json: async () => release }),
    async url => ({ status: 200, url, json: async () => url.endsWith('/app-release')
      ? { ...release, source_commit: '0'.repeat(40) } :
        { env: { value: 'staging' }, git_sha: { value: liveCarr } } }),
    async url => ({ status: 200, url, json: async () => url.endsWith('/app-release')
      ? release : { env: { value: 'staging' }, git_sha: { value: contract.producer.source_commit } } }),
  ]) await assert.rejects(produceLocalAgentPhase({ plan: plan(), release, run: h.run,
    rpc: h.rpc, releaseFetch }), { code: 'agent-live-source-refused' });
  assert.equal(h.calls.length, 0);
});

test('release change after committed write quarantines the exact intent', async t => {
  const h = await harness(t);
  let appReads = 0;
  const releaseFetch = async url => {
    const answer = await h.releaseFetch(url);
    if (url.endsWith('/app-release') && ++appReads === 2)
      return { ...answer, json: async () => ({ ...release, source_commit: '0'.repeat(40) }) };
    return answer;
  };
  const result = await produceLocalAgentPhase({ plan: plan(), release, run: h.run,
    rpc: h.rpc, releaseFetch });
  assert.equal(result.state, 'PENDING_RECONCILIATION');
  assert.equal(h.calls.filter(row => row.name === 'patch-deal-field').length, 1);
});

test('unknown send, false receipt, and forged readback quarantine without retry', async t => {
  for (const bad of ['timeout', 'receipt', 'board', 'cause']) {
    const h = await harness(t);
    let boardReads = 0;
    const rpc = async (name, args) => {
      if (name === 'patch-deal-field' && bad === 'timeout') throw Error('synthetic timeout');
      if (name === 'patch-deal-field' && bad === 'receipt') return { ok: true, event_id: event };
      if (name === 'deal-room-board' && bad === 'board') {
        const answer = board(boardReads++ > 0);
        if (boardReads === 2) answer.deals[0].phase_change.automatic = false;
        return answer;
      }
      if (name === 'read-doc-activity' && bad === 'cause') return { ...activity(), entries: [] };
      return h.rpc(name, args);
    };
    const result = await produceLocalAgentPhase({ plan: plan(), release, run: h.run, rpc,
      releaseFetch: h.releaseFetch });
    assert.equal(result.state, 'PENDING_RECONCILIATION', bad);
    assert.equal(JSON.parse(await readFile(result.journal_path, 'utf8')).state, 'quarantined');
    await assert.rejects(produceLocalAgentPhase({ plan: plan(), release, run: h.run, rpc,
      releaseFetch: h.releaseFetch }),
      { code: 'agent-intent-already-exists' });
  }
});
