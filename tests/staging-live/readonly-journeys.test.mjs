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
const appIdentity = { service: release.service, environment: release.environment, source_commit: release.source_commit };
const dealId = '22222222-2222-4222-8222-222222222222';
const partyId = '88888888-8888-4888-8888-888888888888';
const clientId = '99999999-9999-4999-8999-999999999999';
const unrelatedId = '77777777-7777-4777-8777-777777777777';
const evidenceId = `evidence:${partyId}:${dealId}:referred`;
const dealName = 'SYNTHETIC_PRIVATE_DEAL_NAME';
const partyName = 'SYNTHETIC_PRIVATE_PARTY_NAME';
const originalEntry = 'SYNTHETIC_PRIVATE_ORIGINAL_ENTRY';
const fixturePlan = () => ({ schema: 'doctorcre-staging-records-plan.v1', state: 'complete', run: '33333333-3333-4333-8333-333333333333',
  origin: 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev', inflight: null,
  release: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit },
  keys: { deal: '44444444-4444-4444-8444-444444444444' },
  receipts: { party: { party_id: partyId }, client: { client_id: clientId }, deal: { deal_id: dealId } },
  records: { party: { id: partyId, name: partyName }, client: { id: clientId, name: partyName }, deal: { id: dealId, name: dealName } } });

function configure(t) {
  const prior = { E2E_TARGET: process.env.E2E_TARGET, E2E_RUN_SUPERVISED: process.env.E2E_RUN_SUPERVISED };
  process.env.E2E_TARGET = 'staging-live'; process.env.E2E_RUN_SUPERVISED = '1';
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
}

async function harness(t, { attention = true, identity = true, detail = true, relationship = {}, appRelease = appIdentity,
  readinessDelayMs = 0, freshness = true, teamOnlyFlag = true, boardActor = 'joe', dealOwner = 'joe', boardName = dealName } = {}) {
  configure(t);
  const root = await mkdtemp(join(tmpdir(), 'readonly-journeys-'));
  const run = openRun(root, { runId: 'synthetic-readonly-journeys', events: null, limits: { ...RUN_LIMITS, httpRequests: 100 } });
  t.after(async () => { run.dispose(); await rm(root, { recursive: true, force: true }); });
  let coverageChecks = 0, theme = 'dark', clicks = 0, reloads = 0, evaluations = 0, readinessWaits = 0;
  let markWaitEntered;
  const firstReadinessWait = new Promise(resolve => { markWaitEntered = resolve; });
  const ready = { avatar: readinessDelayMs === 0, home: readinessDelayMs === 0, relationship: readinessDelayMs === 0,
    connection: readinessDelayMs === 0 };
  let homeScope = 'team', referralsTab = false, territoryValue = '', dialogTitle = '', evidenceOpen = false, dialogOpen = false;
  const reads = [], relationshipMethods = [];
  const context = { route: async () => {}, addInitScript: async () => {} };
  await installStagingGuard(context, { forContext: () => ({ handle: async () => {}, assertCoverage: async () => { coverageChecks++; } }) });
  let currentURL = 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev/';
  const network = {
    schema: 'carr-relationship-network.v1', observed_at: new Date().toISOString(), valid_until: new Date(Date.now() + 60_000).toISOString(),
    nodes: [
      { id: `party:${partyId}`, record_id: clientId, kind: 'client', name: partyName, territory: 'SYNTHETIC_NORTH', verticals: [], summary: 'SYNTHETIC_PRIVATE_SUMMARY' },
      { id: `deal:${dealId}`, record_id: dealId, kind: 'deal', name: dealName, territory: 'SYNTHETIC_NORTH', verticals: [] },
      { id: `party:${unrelatedId}`, record_id: unrelatedId, kind: 'vendor', name: 'SYNTHETIC_PRIVATE_OTHER_NAME', territory: 'SYNTHETIC_SOUTH', verticals: [] },
    ],
    edges: [
      { id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${dealId}`, kind: 'client_deal', via: null, detail: null },
      { id: evidenceId, from: `party:${partyId}`, to: `deal:${dealId}`, kind: 'referred', via: null, detail: originalEntry, summary: 'referred' },
    ],
    referrals: [
      { node_id: `party:${partyId}`, deals: 1, won: 1, lost: 0, win_rate: 1 },
      { node_id: `party:${unrelatedId}`, deals: 2, won: 1, lost: 1, win_rate: 0.5 },
    ],
    suggestions: [],
  };
  Object.assign(network, relationship);
  const visible = readyKey => ({ getClientRects: () => readyKey ? ready[readyKey] ? [{ width: 10, height: 10 }] : [] : [{ width: 10, height: 10 }],
    checkVisibility: () => readyKey ? ready[readyKey] : true });
  const selectedScopeButtons = () => ['team', 'mine'].map(scope => ({
    ...visible('home'), getAttribute: key => key === 'data-scope' ? scope : key === 'aria-pressed' ? String(scope === homeScope) : null,
  }));
  const homeFlags = () => {
    const rows = [{ id: dealId, name: dealName }];
    if (homeScope === 'team' && teamOnlyFlag) rows.push({ id: unrelatedId, name: 'SYNTHETIC_PRIVATE_TEAM_ONLY_NAME' });
    return rows.map(row => ({ ...visible('home'), getAttribute: key => key === 'data-home-key' ? `deal:${row.id}` : null,
      querySelector: selector => selector === 'strong' ? { textContent: row.name } : null }));
  };
  const referralCards = () => {
    if (!referralsTab || !ready.relationship) return [];
    const visibleIds = territoryValue === 'SYNTHETIC_NORTH' ? [partyId]
      : territoryValue === 'SYNTHETIC_SOUTH' ? [unrelatedId] : [partyId, unrelatedId];
    return visibleIds.map(id => {
      const isOwned = id === partyId;
      const metrics = isOwned ? { deals: 1, won: 1, lost: 0, win_rate: 1 } : { deals: 2, won: 1, lost: 1, win_rate: 0.5 };
      return { ...visible('relationship'), getAttribute: key => key === 'data-node' ? `party:${id}` : null,
        querySelector: selector => selector === 'strong' ? { textContent: isOwned ? partyName : 'SYNTHETIC_PRIVATE_OTHER_NAME' }
          : selector === 'b' ? { textContent: String(metrics.deals) }
            : selector === '.referral-rate' ? { textContent: `${Math.round(metrics.win_rate * 100)}% win rate` }
              : selector === 'small' ? { textContent: `${metrics.won} won · ${metrics.lost} lost · ${metrics.deals - metrics.won - metrics.lost} open` } : null };
    });
  };
  const targetNode = () => ({ ...visible('relationship'), getAttribute: key => key === 'data-node' ? `party:${partyId}` : null,
    matches: selector => selector === '.relationship-node', click: () => { dialogTitle = partyName; dialogOpen = true; } });
  const metricBoxes = [
    { querySelector: selector => selector === 'strong' ? { textContent: '1' } : selector === 'span' ? { textContent: 'Deals sent' } : null },
    { querySelector: selector => selector === 'strong' ? { textContent: '100%' } : selector === 'span' ? { textContent: 'Win rate · 1 won / 1 resolved' } : null },
  ];
  const dialog = {
    querySelector: selector => selector === '#relationshipTitle' ? { textContent: dialogTitle }
      : selector === '.relationship-metrics' ? { querySelectorAll: inner => inner === 'div' ? metricBoxes : [] }
        : selector === `details[data-entry="${evidenceId}"]` ? { open: evidenceOpen,
          querySelector: inner => inner === 'p' ? { textContent: originalEntry } : null } : null,
    querySelectorAll: selector => selector === '[data-open-node]' && dialogTitle === partyName && ready.connection
      ? [{ ...visible('relationship'), getAttribute: key => key === 'data-open-node' ? `deal:${dealId}` : key === 'data-card-key' ? `client-deal:${dealId}` : null,
        click: () => { dialogTitle = dealName; } }] : [],
  };
  const documentForHarness = () => ({
    documentElement: { getAttribute: key => key === 'data-theme' ? theme : null },
    querySelector: selector => {
      if (selector === '.relationship-dialog') return dialog;
      if (selector === '#selfAvatar') return { ...visible('avatar'), getAttribute: () => 'Joe: account and settings', textContent: ready.avatar ? 'J' : '…' };
      if (selector === '#appSyncTime') return { ...visible(), textContent: freshness ? '10:15 AM' : '—', dateTime: freshness ? new Date().toISOString() : '' };
      if (selector === '#dealAttention') return { getAttribute: key => key === 'aria-busy' ? String(!ready.home) : null };
      if (selector === '#networkUpdated') return { textContent: ready.relationship ? 'Updated just now' : 'Updating…' };
      if (selector === '#networkTerritory') return { value: territoryValue };
      if (selector === '#networkSearch') return { value: '' };
      if (selector === '#networkVertical') return { value: '' };
      if (selector === '#referralsTab') return { getAttribute: key => key === 'aria-selected' ? String(referralsTab) : null };
      if (selector === `details[data-entry="${evidenceId}"]`) return { open: evidenceOpen, querySelector: inner => inner === 'p' ? { textContent: originalEntry } : null };
      return null;
    },
    querySelectorAll: selector => {
      if (selector === 'button[data-pref="theme"]') return [{ disabled: false, ...visible() }];
      if (selector === contract.journeys.W2.scope_selector) return selectedScopeButtons();
      if (selector === contract.journeys.W2.flags_selector) return homeFlags();
      if (selector === '#networkReferrals .relationship-referral') return referralCards();
      if (selector === '[data-node]' || selector === `[data-node="party:${partyId}"]`)
        return ready.relationship && !referralsTab ? [targetNode()] : [];
      if (selector === `[data-node="party:${partyId}"]`) return ready.relationship ? [targetNode()] : [];
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
        if (url === contract.journeys.W14.snapshot_path) {
          relationshipMethods.push(options.method || 'GET');
          return { ok: true, json: async () => network };
        }
        if (url === '/mcp') {
          const request = JSON.parse(options.body), name = request.params.name;
          reads.push(name);
          const value = name === 'deal-room-board' ? { actor: boardActor, deals: [{ id: dealId, name: boardName, owner: dealOwner, attention }] }
            : name === 'get-deal-room' ? (detail ? { deal_id: dealId } : { deal_id: unrelatedId }) : null;
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
      count: async () => selector.includes('data-layout-deal') ? Number(attention)
        : selector.includes('details[data-entry=') ? Number(network.edges.some(edge => edge.id === evidenceId)) : 1,
      first() { return this; },
      waitFor: async () => {},
      click: async () => {
        clicks++;
        if (selector.includes('data-pref')) theme = theme === 'dark' ? 'light' : 'dark';
        else if (selector.includes('[data-scope="mine"]')) homeScope = 'mine';
        else if (selector.includes('[data-scope="team"]')) homeScope = 'team';
        else if (selector.includes('data-home-key="deal:')) currentURL = `https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev/deals?deal=${dealId}`;
        else if (selector.includes('details[data-entry=')) evidenceOpen = true;
        else if (selector.includes('[data-close-card]')) { dialogOpen = false; dialogTitle = ''; }
        else if (selector === contract.journeys.W14.referrals_tab_selector) referralsTab = true;
        else if (selector === '#graphTab') referralsTab = false;
        else if (selector === contract.journeys.W14.reset_selector) territoryValue = '';
      },
      selectOption: async value => { territoryValue = value; },
    }),
    goto: async url => {
      currentURL = url; referralsTab = false; territoryValue = '';
      if (url.endsWith(contract.journeys.W2.route)) { homeScope = 'team'; ready.home = readinessDelayMs === 0; }
      if (url.endsWith(contract.journeys.W14.route)) { ready.relationship = readinessDelayMs === 0; ready.connection = readinessDelayMs === 0; }
    },
    reload: async () => { reloads++; },
    waitForURL: async predicate => { assert.equal(predicate(new URL(currentURL)), true); },
    waitForFunction: async (predicate, arg, { timeout = 1000 } = {}) => {
      readinessWaits++;
      markWaitEntered?.(); markWaitEntered = null;
      const readyKey = arg?.avatarSelector ? 'avatar' : arg?.scopeSelector ? 'home'
        : arg?.nodeId ? 'relationship' : arg?.partyId ? 'relationship' : arg?.dealId ? 'connection' : null;
      if (readinessDelayMs > 0 && readyKey) setTimeout(() => {
        ready[readyKey] = true;
        if (readyKey === 'relationship') ready.connection = true;
      }, readinessDelayMs);
      const expires = Date.now() + Math.min(timeout, 50);
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

test('synthetic W1/W2/W14 behaviors use exact plan bindings; only complete slices qualify and no names or IDs escape', async t => {
  const h = await harness(t);
  const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
  assert.equal(result.full_v1_qualified, false);
  assert.deepEqual(result.journeys.map(row => [row.journey, row.state]), [
    ['W1', 'pending'], ['W2', 'qualified-slice'], ['W5', 'pending'], ['W14', 'qualified-slice'],
  ]);
  assert.equal(result.journeys[0].reason, 'dedicated-session-auth-lifecycle-unavailable');
  assert.equal(result.journeys[0].freshness_theme_controls_after_reload, true);
  assert.equal(result.journeys[0].isolated_sign_in_sign_out, false);
  assert.deepEqual(result.counts, { qualified_slices: 2, pending_slices: 2, module_api_reads: 6, http_gets: 4, mcp_reads: 2, carr_record_mutations: 0 });
  for (const privateValue of [dealId, partyId, clientId, unrelatedId, dealName, partyName, originalEntry, 'SYNTHETIC_PRIVATE_OTHER_NAME'])
    assert.equal(JSON.stringify(result).includes(privateValue), false, `result omitted ${privateValue}`);
  assert.equal(h.checks().coverageChecks, 2);
  assert.equal(h.checks().reloads, 1);
  assert.deepEqual(h.reads, ['deal-room-board', 'get-deal-room']);
  assert.deepEqual(h.relationshipMethods, ['GET']);
});

test('W2 stays pending without a distinct Team-only flagged row or the exact plan-owned deal', async t => {
  const h = await harness(t, { teamOnlyFlag: false });
  const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
  assert.equal(result.journeys.find(row => row.journey === 'W2').state, 'pending');
  assert.equal(h.reads.includes('get-deal-room'), false, 'detail read follows only a complete scope reset and exact UI open');
  assert.equal(result.full_v1_qualified, false);
});

test('W2 requires a fresh owned attention observation, exact current name, and independent detail readback', async t => {
  for (const options of [{ attention: false }, { detail: false }, { dealOwner: 'dell' },
    { boardActor: 'dell' }, { boardName: 'SYNTHETIC_PRIVATE_WRONG_DEAL_NAME' }]) {
    const h = await harness(t, options);
    const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
    assert.equal(result.journeys.find(row => row.journey === 'W2').state, 'pending');
    assert.equal(result.counts.carr_record_mutations, 0);
  }
});

test('W1 does not report theme persistence when the freshness witness is stale or absent', async t => {
  const h = await harness(t, { freshness: false });
  const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
  const w1 = result.journeys.find(row => row.journey === 'W1');
  assert.equal(w1.state, 'pending');
  assert.equal(w1.reason, 'avatar-freshness-or-theme-persistence-unproved');
  assert.equal(w1.freshness_theme_controls_after_reload, false);
  assert.equal(h.checks().reloads, 0);
});

test('W1 freshness wait, W2 Home renders and W14 relationship renders are awaited before proof', async t => {
  const h = await harness(t, { readinessDelayMs: 15 });
  const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
  assert.equal(result.journeys.find(row => row.journey === 'W1').freshness_theme_controls_after_reload, true);
  assert.equal(result.journeys.find(row => row.journey === 'W2').state, 'qualified-slice');
  assert.equal(result.journeys.find(row => row.journey === 'W14').state, 'qualified-slice');
  assert.equal(h.checks().readinessWaits >= 7, true, 'async freshness, scope, relationship, referrals, reset and owned connection states were waited');
  assert.equal(result.full_v1_qualified, false);
});

test('global stop interrupts a pending freshness wait before later journey reads', async t => {
  const h = await harness(t, { readinessDelayMs: 50 });
  const running = runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
  await h.firstReadinessWait;
  h.run.stop('synthetic-stop');
  await assert.rejects(running, /synthetic-stop/);
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.relationshipMethods, []);
});

test('missing plan records or any provenance mismatch do not substitute arbitrary live records', async t => {
  for (const alter of [
    plan => { delete plan.records.deal; },
    plan => { plan.origin = 'https://example.invalid'; },
    plan => { plan.inflight = { name: 'new-deal' }; },
    plan => { plan.receipts.deal.deal_id = unrelatedId; },
    plan => { plan.records.deal.id = unrelatedId; },
    plan => { plan.release.source_commit = 'b'.repeat(40); },
    plan => { plan.receipts.client.client_id = unrelatedId; },
    plan => { plan.receipts.party.party_id = unrelatedId; },
    plan => { plan.records.client.id = unrelatedId; },
  ]) {
    const h = await harness(t);
    const plan = fixturePlan(); alter(plan);
    const result = await runReadonlyJourneys({ page: h.page, release, plan, run: h.run });
    assert.equal(result.journeys.find(row => row.journey === 'W2').state, 'pending');
    assert.equal(result.journeys.find(row => row.journey === 'W14').state, 'pending');
    assert.equal(h.reads.includes('deal-room-board'), false);
    assert.deepEqual(h.relationshipMethods, []);
  }
});

test('an empty party creation receipt gives W2 and W14 a precise pending prerequisite', async t => {
  const h = await harness(t);
  const plan = fixturePlan(); plan.receipts.party = {};
  const result = await runReadonlyJourneys({ page: h.page, release, plan, run: h.run });
  for (const journey of ['W2', 'W14']) {
    const row = result.journeys.find(value => value.journey === journey);
    assert.equal(row.state, 'pending');
    assert.equal(row.reason, 'owned-plan-party-receipt-unavailable');
  }
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.relationshipMethods, []);
});

test('W14 missing plan-owned evidence or referral metrics remains pending after checked snapshot', async t => {
  const noEvidence = await harness(t, { relationship: { edges: [{ id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${dealId}`, kind: 'client_deal', via: null }] } });
  const missingEvidenceResult = await runReadonlyJourneys({ page: noEvidence.page, release, plan: fixturePlan(), run: noEvidence.run });
  const missingEvidence = missingEvidenceResult.journeys.find(row => row.journey === 'W14');
  assert.equal(missingEvidence.state, 'pending');
  assert.equal(missingEvidence.reason, 'owned-party-evidence-entry-unavailable');

  const noReferral = await harness(t, { relationship: { referrals: [] } });
  const missingReferralResult = await runReadonlyJourneys({ page: noReferral.page, release, plan: fixturePlan(), run: noReferral.run });
  const missingReferral = missingReferralResult.journeys.find(row => row.journey === 'W14');
  assert.equal(missingReferral.state, 'pending');
  assert.equal(missingReferral.reason, 'owned-party-referral-metrics-unavailable');
  assert.equal(JSON.stringify(missingReferralResult).includes(originalEntry), false);
});

test('W14 requires the displayed original entry, displayed metrics, and an observable territory filter reset', async t => {
  const changedEntry = await harness(t, { relationship: { edges: [
    { id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${dealId}`, kind: 'client_deal', via: null },
    { id: evidenceId, from: `party:${partyId}`, to: `deal:${dealId}`, kind: 'referred', via: null, detail: 'SYNTHETIC_PRIVATE_SUBSTITUTED_ENTRY' },
  ] } });
  const changedEntryResult = await runReadonlyJourneys({ page: changedEntry.page, release, plan: fixturePlan(), run: changedEntry.run });
  assert.equal(changedEntryResult.journeys.find(row => row.journey === 'W14').reason, 'owned-party-evidence-entry-unavailable');

  const changedMetrics = await harness(t, { relationship: { referrals: [
    { node_id: `party:${partyId}`, deals: 3, won: 2, lost: 1, win_rate: 2 / 3 },
    { node_id: `party:${unrelatedId}`, deals: 2, won: 1, lost: 1, win_rate: 0.5 },
  ] } });
  const changedMetricsResult = await runReadonlyJourneys({ page: changedMetrics.page, release, plan: fixturePlan(), run: changedMetrics.run });
  assert.equal(changedMetricsResult.journeys.find(row => row.journey === 'W14').reason, 'owned-party-referral-metrics-unavailable');

  const noFilterContrast = await harness(t, { relationship: { referrals: [
    { node_id: `party:${partyId}`, deals: 1, won: 1, lost: 0, win_rate: 1 },
  ] } });
  const noFilterContrastResult = await runReadonlyJourneys({ page: noFilterContrast.page, release, plan: fixturePlan(), run: noFilterContrast.run });
  assert.equal(noFilterContrastResult.journeys.find(row => row.journey === 'W14').reason, 'territory-filter-effect-unavailable');
});

test('W14 refuses stale, duplicate or substituted plan nodes and mismatched association or evidence edges', async t => {
  const stale = { observed_at: new Date(Date.now() - 120_000).toISOString(), valid_until: new Date(Date.now() - 60_000).toISOString() };
  const altered = [
    [{ schema: 'other.v1' }, 'fresh-relationship-snapshot-unavailable'],
    [stale, 'fresh-relationship-snapshot-unavailable'],
    [{ nodes: [{ id: `party:${partyId}`, record_id: clientId, kind: 'client', name: partyName }] }, 'owned-relationship-nodes-unavailable'],
    [{ nodes: [{ id: `party:${partyId}`, record_id: clientId, kind: 'client', name: partyName }, { id: `party:${partyId}`, record_id: clientId, kind: 'client', name: 'SYNTHETIC_PRIVATE_DUPLICATE' }] }, 'owned-relationship-nodes-unavailable'],
    [{ edges: [{ id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${unrelatedId}`, kind: 'client_deal', via: null }] }, 'owned-client-deal-edge-unavailable'],
    [{ edges: [{ id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${dealId}`, kind: 'client_deal', via: null }, { id: evidenceId, from: `party:${unrelatedId}`, to: `deal:${dealId}`, kind: 'referred', via: null, detail: originalEntry }] }, 'owned-party-evidence-entry-unavailable'],
    [{ edges: [{ id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${dealId}`, kind: 'client_deal', via: null },
      { id: evidenceId, from: `party:${partyId}`, to: `deal:${unrelatedId}`, kind: 'referred', via: null, detail: originalEntry }] }, 'owned-party-evidence-entry-unavailable'],
  ];
  for (const [index, [change, reason]] of altered.entries()) {
    const h = await harness(t, { relationship: change });
    const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
    const w14 = result.journeys.find(row => row.journey === 'W14');
    assert.equal(w14.state, 'pending');
    assert.equal(w14.reason, reason, `synthetic mutation case ${index}`);
    for (const privateValue of [partyId, dealId, originalEntry]) assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test('failed actor, source pair or guarded-page proof blocks dependent reads and clicks', async t => {
  for (const options of [{ identity: false }, { appRelease: { ...release, source_commit: 'b'.repeat(40) } }]) {
    const h = await harness(t, options);
    const result = await runReadonlyJourneys({ page: h.page, release, plan: fixturePlan(), run: h.run });
    assert.equal(result.journeys.find(row => row.journey === 'W2').state, 'pending');
    assert.equal(result.journeys.find(row => row.journey === 'W14').state, 'pending');
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.relationshipMethods, []);
    assert.equal(h.checks().clicks, 0);
    assert.equal(result.full_v1_qualified, false);
  }
  const h = await harness(t);
  await assert.rejects(runReadonlyJourneys({ page: h.page, release: { ...release, carr_source_commit: 'b'.repeat(40) }, plan: fixturePlan(), run: h.run }), /source or guarded page refused/);
  await assert.rejects(runReadonlyJourneys({ page: { ...h.page, context: () => ({}) }, release, plan: fixturePlan(), run: h.run }), /Staging context has no fixture guard/);
  assert.equal(h.checks().evaluations, 0);
});
