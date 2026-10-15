import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installStagingGuard } from '../../scripts/e2e-staging/engine.mjs';
import { openRun, RUN_LIMITS } from '../../scripts/e2e-staging/run-limits.mjs';
import { runReadonlyJourneys } from '../../scripts/e2e-staging/readonly-journeys.mjs';
import contract from '../../contracts/e2e-staging-readonly-journeys.v1.json' with { type: 'json' };

const release = Object.freeze({ service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit });
const dealId = '22222222-2222-4222-8222-222222222222';
const partyId = '88888888-8888-4888-8888-888888888888';
const clientId = '99999999-9999-4999-8999-999999999999';
const fixturePlan = () => ({ schema: 'doctorcre-staging-records-plan.v1', state: 'complete', run: '33333333-3333-4333-8333-333333333333',
  origin: 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev', inflight: null,
  release: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit },
  keys: { deal: '44444444-4444-4444-8444-444444444444' },
  receipts: { party: { party_id: partyId }, client: { client_id: clientId }, deal: { deal_id: dealId } },
  records: { party: { id: partyId }, client: { id: clientId }, deal: { id: dealId, name: 'PRIVATE_NAME_CANARY' } } });

function configure(t) {
  const prior = { E2E_TARGET: process.env.E2E_TARGET, E2E_RUN_SUPERVISED: process.env.E2E_RUN_SUPERVISED };
  process.env.E2E_TARGET = 'staging-live'; process.env.E2E_RUN_SUPERVISED = '1';
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
}

async function harness(t, { attention = true, identity = true, detail = true, relationship = {}, appRelease = release, readinessDelayMs = 0 } = {}) {
  configure(t);
  const root = await mkdtemp(join(tmpdir(), 'readonly-journeys-'));
  const run = openRun(root, { runId: 'synthetic-readonly-journeys', events: null, limits: { ...RUN_LIMITS, httpRequests: 100 } });
  t.after(async () => { run.dispose(); await rm(root, { recursive: true, force: true }); });
  let coverageChecks = 0, theme = 'dark', clicks = 0, reloads = 0, evaluations = 0, readinessWaits = 0;
  let markWaitEntered;
  const firstReadinessWait = new Promise(resolve => { markWaitEntered = resolve; });
  const ready = { avatar: readinessDelayMs === 0, working: readinessDelayMs === 0, today: readinessDelayMs === 0,
    relationship: readinessDelayMs === 0, connection: readinessDelayMs === 0 };
  const reads = [], relationshipMethods = [];
  const context = { route: async () => {}, addInitScript: async () => {} };
  await installStagingGuard(context, { forContext: () => ({ handle: async () => {}, assertCoverage: async () => { coverageChecks++; } }) });
  let currentURL = 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev/', relationshipTitle = '';
  const network = {
    schema: 'carr-relationship-network.v1', observed_at: new Date().toISOString(), valid_until: new Date(Date.now() + 60_000).toISOString(),
    nodes: [
      { id: `party:${partyId}`, record_id: clientId, kind: 'client', name: 'PRIVATE_CLIENT_NAME_CANARY' },
      { id: `deal:${dealId}`, record_id: dealId, kind: 'deal', name: 'PRIVATE_DEAL_NAME_CANARY' },
    ],
    edges: [{ id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${dealId}`, kind: 'client_deal', via: null }],
    referrals: [], suggestions: [],
  };
  Object.assign(network, relationship);
  const documentForHarness = () => ({
    documentElement: { getAttribute: key => key === 'data-theme' ? theme : null },
    querySelector: selector => {
      if (selector === '.relationship-dialog') return {
        querySelector: inner => inner === '#relationshipTitle' ? { textContent: relationshipTitle } : null,
        querySelectorAll: inner => inner === '[data-open-node]' && relationshipTitle === 'PRIVATE_CLIENT_NAME_CANARY' && ready.connection
          ? [{ getAttribute: key => key === 'data-open-node' ? `deal:${dealId}` : null,
            click: () => { relationshipTitle = 'PRIVATE_DEAL_NAME_CANARY'; },
            getClientRects: () => [{ width: 10, height: 10 }], checkVisibility: () => true }] : [],
      };
      if (selector === `.relationship-node[data-node="party:${partyId}"]` || selector === `[data-node="party:${partyId}"]`)
        return ready.relationship ? { click: () => { relationshipTitle = 'PRIVATE_CLIENT_NAME_CANARY'; },
          getClientRects: () => [{ width: 10, height: 10 }], checkVisibility: () => true } : null;
      if (selector === '#selfAvatar') return { getAttribute: () => 'Joe: account and settings', textContent: ready.avatar ? 'J' : '…',
        getClientRects: () => ready.avatar ? [{ width: 10, height: 10 }] : [], checkVisibility: () => ready.avatar };
      if (selector === '#appWorkingList' || selector === '#appTodayNeeds') return {
        querySelectorAll: () => attention && (selector === '#appWorkingList' ? ready.working : ready.today)
          ? [{ getAttribute: () => dealId, getClientRects: () => [{ width: 10, height: 10 }], checkVisibility: () => true }] : [],
      };
      return null;
    },
    querySelectorAll: selector => {
      if (selector === 'button[data-pref="theme"]') return [{ disabled: false, getClientRects: () => [{ width: 10, height: 10 }], checkVisibility: () => true }];
      if (selector === '[data-node]' || selector === `[data-node="party:${partyId}"]`) return ready.relationship ? [{
        getAttribute: () => `party:${partyId}`, matches: () => true,
        click: () => { relationshipTitle = 'PRIVATE_CLIENT_NAME_CANARY'; },
        getClientRects: () => [{ width: 10, height: 10 }], checkVisibility: () => true,
      }] : [];
      return [];
    },
  });
  const page = {
    url: () => currentURL,
    context: () => context,
    evaluate: async (fn, args) => {
      evaluations++;
      const savedFetch = globalThis.fetch, savedDocument = globalThis.document;
      globalThis.fetch = async (path, options = {}) => {
        const url = String(path);
        if (url === '/app-release') return { ok: true, json: async () => ({ ...appRelease }) };
        if (url === '/auth/session') return { ok: identity, json: async () => ({ actor: { slug: 'joe' }, e2e_principal: 'e2e-joe' }) };
        if (url === '/api/system-work/session') return { ok: identity, json: async () => ({ actor: { slug: 'joe' } }) };
        if (url === '/api/v1/business/relationships?contract=relationship-network.v1') {
          relationshipMethods.push(options.method || 'GET');
          return { ok: true, json: async () => network };
        }
        if (url === '/mcp') {
          const request = JSON.parse(options.body), name = request.params.name;
          reads.push(name);
          const value = name === 'deal-room-board' ? { actor: 'joe', deals: [{ id: dealId, owner: 'joe', attention }] }
            : name === 'today-triage' ? { items: [] }
              : name === 'get-deal-room' ? (detail ? { deal_id: dealId } : { deal_id: '55555555-5555-4555-8555-555555555555' }) : null;
          return { ok: value !== null, json: async () => ({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }) };
        }
        throw new Error('Synthetic fetch target refused');
      };
      globalThis.document = documentForHarness();
      try { return await fn(args); }
      finally {
        globalThis.fetch = savedFetch;
        if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
      }
    },
    locator: selector => ({
      count: async () => selector.includes('data-layout-deal') ? Number(attention) : 1,
      first() { return this; },
      waitFor: async () => {},
      click: async () => {
        clicks++;
        if (selector.includes('data-pref')) theme = theme === 'dark' ? 'light' : 'dark';
        if (selector.includes('data-layout-deal')) currentURL = `https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev/deals?deal=${dealId}`;
      },
    }),
    goto: async url => { currentURL = url; },
    reload: async () => { reloads++; },
    waitForURL: async predicate => { assert.equal(predicate(new URL(currentURL)), true); },
    waitForFunction: async (predicate, arg, { timeout = 1000 } = {}) => {
      readinessWaits++;
      markWaitEntered?.(); markWaitEntered = null;
      const readyKey = arg?.avatarSelector ? 'avatar' : arg?.workingSelector ? 'working'
        : arg?.nodeId ? 'relationship' : arg?.dealId ? 'connection' : null;
      if (readinessDelayMs > 0 && readyKey) setTimeout(() => {
        if (readyKey === 'working') { ready.working = true; ready.today = true; }
        else ready[readyKey] = true;
      }, readinessDelayMs);
      const expires = Date.now() + timeout;
      while (Date.now() < expires) {
        const savedDocument = globalThis.document;
        globalThis.document = documentForHarness();
        let matched;
        try { matched = predicate(arg); } finally {
          if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
        }
        if (matched) return;
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      throw new Error('Synthetic DOM readiness timeout');
    },
  };
  return { page, run, reads, relationshipMethods, firstReadinessWait,
    checks: () => ({ coverageChecks, clicks, reloads, evaluations, readinessWaits }) };
}

test('synthetic harness exercises only the scoped W1 and W2 logic and emits no record identifiers or names', async t => {
  const h = await harness(t);
  const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
  assert.equal(result.full_v1_qualified, false);
  assert.deepEqual(result.journeys.slice(0, 2).map(row => row.state), ['qualified-slice', 'qualified-slice']);
  assert.deepEqual(result.journeys.slice(2).map(row => [row.journey, row.state]), [
    ['W5', 'pending'], ['W14', 'qualified-slice'],
  ]);
  assert.deepEqual(result.counts, { qualified_slices: 3, pending_slices: 1, module_api_reads: 8, http_gets: 5, mcp_reads: 3, carr_record_mutations: 0 });
  assert.equal(JSON.stringify(result).includes(dealId), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_NAME_CANARY'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_CLIENT_NAME_CANARY'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_DEAL_NAME_CANARY'), false);
  assert.equal(h.checks().coverageChecks, 2);
  assert.equal(h.checks().clicks, 2);
  assert.equal(h.checks().reloads, 1);
  assert.deepEqual(h.reads, ['deal-room-board', 'today-triage', 'get-deal-room']);
  assert.deepEqual(h.relationshipMethods, ['GET']);
});

test('W2 remains pending unless the plan-owned deal is freshly observed in attention', async t => {
  const h = await harness(t, { attention: false });
  const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
  assert.deepEqual(result.journeys[1], { journey: 'W2', state: 'pending', reason: 'owned-plan-deal-not-freshly-observed-in-attention' });
  assert.equal(result.counts.module_api_reads, 7);
  assert.equal(h.checks().clicks, 1, 'only the local theme control is clicked');
});

test('W2 requires current panels and independent exact-deal detail readback', async t => {
  const h = await harness(t, { detail: false });
  const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
  assert.deepEqual(result.journeys[1], { journey: 'W2', state: 'pending', reason: 'independent-deal-detail-readback-unproved' });
  assert.equal(result.counts.module_api_reads, 8);
  assert.equal(result.counts.module_api_reads <= contract.limits.module_api_reads_max, true);
  assert.equal(result.counts.carr_record_mutations, 0);
});

test('W1, W2, and W14 wait for delayed owned UI renders before qualifying', async t => {
  const h = await harness(t, { readinessDelayMs: 15 });
  const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
  assert.deepEqual(['W1', 'W2', 'W14'].map(id => result.journeys.find(row => row.journey === id).state),
    ['qualified-slice', 'qualified-slice', 'qualified-slice']);
  assert.equal(h.checks().readinessWaits >= 5, true, 'each asynchronous UI surface and the owned connection must pass readiness waits');
  assert.equal(JSON.stringify(result).includes('PRIVATE_CLIENT_NAME_CANARY'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_DEAL_NAME_CANARY'), false);
  assert.equal(result.full_v1_qualified, false);
});

test('global stop interrupts a pending readiness wait before W2 or W14 reads', async t => {
  const h = await harness(t, { readinessDelayMs: 50 });
  const running = runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
  await h.firstReadinessWait;
  h.run.stop('synthetic-stop');
  await assert.rejects(running, /synthetic-stop/);
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.relationshipMethods, []);
  assert.equal(h.checks().clicks, 0);
});

test('missing owned plan deal produces pending W2 without broad attention or detail reads', async t => {
  const h = await harness(t);
  const plan = fixturePlan(); delete plan.records.deal;
  const result = await runReadonlyJourneys({ page: h.page, release, plan, run: h.run });
  assert.deepEqual(result.journeys[1], { journey: 'W2', state: 'pending', reason: 'owned-plan-deal-unavailable' });
  assert.equal(result.counts.module_api_reads, 3);
  assert.equal(h.checks().evaluations, 4, 'identity and theme reads only; no MCP reads for unrelated deals');
});

test('failed authenticated identity leaves dependent journeys pending without MCP, relationship, or UI actions', async t => {
  const h = await harness(t, { identity: false });
  const plan = fixturePlan();
  const result = await runReadonlyJourneys({ page: h.page, release, plan, run: h.run });
  assert.deepEqual(result.journeys[0], { journey: 'W1', state: 'pending', reason: 'authenticated-source-pair-unavailable' });
  assert.equal(result.journeys[1].state, 'pending');
  assert.equal(result.journeys.find(row => row.journey === 'W14').state, 'pending');
  assert.equal(result.counts.mcp_reads, 0);
  assert.deepEqual(h.relationshipMethods, []);
  assert.deepEqual(h.reads, []);
  assert.equal(h.checks().clicks, 0);
  assert.equal(h.checks().reloads, 0);
  assert.equal(result.full_v1_qualified, false);
});

test('fresh app source mismatch blocks W2 and W14 before their MCP or relationship reads', async t => {
  const h = await harness(t, { appRelease: { ...release, source_commit: 'b'.repeat(40) } });
  const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
  assert.equal(result.journeys[0].state, 'pending');
  assert.equal(result.journeys[1].state, 'pending');
  assert.equal(result.journeys.find(row => row.journey === 'W14').state, 'pending');
  assert.equal(result.counts.mcp_reads, 0);
  assert.deepEqual(h.relationshipMethods, []);
  assert.deepEqual(h.reads, []);
  assert.equal(h.checks().clicks, 0);
  assert.equal(result.full_v1_qualified, false);
});

test('malformed plan provenance or ownership never qualifies W2 or W14', async t => {
  for (const alter of [
    plan => { plan.origin = 'https://example.invalid'; },
    plan => { plan.inflight = { name: 'new-deal' }; },
    plan => { plan.receipts.deal.deal_id = '66666666-6666-4666-8666-666666666666'; },
    plan => { plan.records.deal.id = '77777777-7777-4777-8777-777777777777'; },
    plan => { plan.release.source_commit = 'b'.repeat(40); },
    plan => { plan.receipts.client.client_id = '66666666-6666-4666-8666-666666666666'; },
    plan => { plan.receipts.party.party_id = '66666666-6666-4666-8666-666666666666'; },
    plan => { plan.records.client.id = '66666666-6666-4666-8666-666666666666'; },
  ]) {
    const h = await harness(t);
    const plan = fixturePlan(); alter(plan);
    const result = await runReadonlyJourneys({ page: h.page, release, plan, run: h.run });
    assert.equal(result.journeys[1].state, 'pending');
    assert.equal(result.journeys.find(row => row.journey === 'W14').state, 'pending');
    assert.equal(result.counts.mcp_reads, 0);
    assert.deepEqual(h.relationshipMethods, [], 'rejected shared plan ownership prevents W14 snapshot reads');
    assert.deepEqual(h.reads, []);
  }
});

test('W14 refuses stale snapshots, substituted or duplicate nodes, and mismatched association edges', async t => {
  const stale = { observed_at: new Date(Date.now() - 120_000).toISOString(), valid_until: new Date(Date.now() - 60_000).toISOString() };
  const altered = [
    [{ schema: 'other.v1' }, 'fresh-relationship-snapshot-unavailable'],
    [stale, 'fresh-relationship-snapshot-unavailable'],
    [{ nodes: [{ id: `party:${partyId}`, record_id: clientId, kind: 'client', name: 'x' }] }, 'owned-relationship-nodes-unavailable'],
    [{ nodes: [{ id: `party:${partyId}`, record_id: clientId, kind: 'client', name: 'x' }, { id: `party:${partyId}`, record_id: clientId, kind: 'client', name: 'y' }] }, 'owned-relationship-nodes-unavailable'],
    [{ edges: [{ id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${partyId}`, kind: 'client_deal', via: null }] }, 'owned-client-deal-edge-unavailable'],
    [{ edges: [{ id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${dealId}`, kind: 'client_deal', via: null }, { id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${dealId}`, kind: 'client_deal', via: null }] }, 'owned-client-deal-edge-unavailable'],
    [{ edges: [{ id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${dealId}`, kind: 'client_deal', via: null }, { id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${partyId}`, kind: 'client_deal', via: null }] }, 'owned-client-deal-edge-unavailable'],
  ];
  for (const [change, reason] of altered) {
    const h = await harness(t, { relationship: change });
    const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
    assert.deepEqual(result.journeys.find(row => row.journey === 'W14'), { journey: 'W14', state: 'pending', reason });
    assert.equal(JSON.stringify(result).includes(partyId), false);
    assert.equal(JSON.stringify(result).includes(dealId), false);
  }
});

test('source mismatch and unguarded page refuse before browser evaluation', async t => {
  const h = await harness(t);
  await assert.rejects(runReadonlyJourneys({ page: h.page, release: { ...release, carr_source_commit: 'b'.repeat(40) }, plan: fixturePlan(), run: h.run }), /source or guarded page refused/);
  const unguarded = { ...h.page, context: () => ({}) };
  await assert.rejects(runReadonlyJourneys({ page: unguarded, release, plan: fixturePlan(), run: h.run }), /Staging context has no fixture guard/);
  assert.equal(h.checks().evaluations, 0);
});
