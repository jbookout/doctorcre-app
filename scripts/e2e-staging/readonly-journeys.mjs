import contract from '../../contracts/e2e-staging-readonly-journeys.v1.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { requireSupervisedRun } from './run-limits.mjs';
import { STAGING_ORIGIN } from './session.mjs';
import { stagingAuth } from './auth-contract.mjs';
import { assertStagingContextCoverage } from './engine.mjs';
import { qualifySessionJourney } from './session-journey.mjs';
import { observedV1Action } from './v1-qualification.mjs';

const commit = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const pending = (journey, reason) => ({ journey, state: 'pending', reason });

// This function is serialized into the guarded page. Its only network path is
// same-origin fetch, so installStagingGuard remains the sole HTTP policy/meter.
async function browserRead({ task, dealId, partyId, clientId, clientRef, partyNameDigest, dealNameDigest, dealNameDigestExpected, evidenceEdgeId, evidenceDetailDigest, referralMetrics, territory, contract: spec }) {
  const textDigest = async value => {
    const bytes = new TextEncoder().encode(value || '');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const json = async (path) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return response.json();
  };
  const rpc = async (name, args = {}) => {
    const response = await fetch('/mcp', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `readonly-${name}`, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!response.ok) return null;
    const envelope = await response.json();
    if (envelope?.error || envelope?.result?.isError) return null;
    const text = envelope?.result?.content?.find(item => item?.type === 'text')?.text;
    if (typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch { return null; }
  };
  if (task === 'identity') {
    const [release, session, actor] = await Promise.all([
      json('/app-release'), json('/auth/session'), json('/api/system-work/session'),
    ]);
    return {
      release: release && { service: release.service, environment: release.environment, source_commit: release.source_commit, carr_source_commit: release.carr_source_commit },
      session: session && { actor_slug: session.actor?.slug, e2e_principal: session.e2e_principal },
      actor_slug: actor?.actor?.slug,
    };
  }
  if (task === 'party-reuse-live') {
    const [client, deal, network] = await Promise.all([
      json(`/api/v1/business/clients/${clientId}`),
      rpc(spec.journeys.W2.detail_tool, { deal: dealId }),
      json(spec.journeys.W14.snapshot_path),
    ]);
    const now = Date.now(), observed = Date.parse(network?.observed_at), valid = Date.parse(network?.valid_until);
    const clientNodeId = `party:${partyId}`, dealNodeId = `deal:${dealId}`;
    const partyNodes = network?.nodes?.filter(node => node?.id === clientNodeId) || [];
    const dealNodes = network?.nodes?.filter(node => node?.id === dealNodeId) || [];
    const edges = network?.edges?.filter(edge => edge?.id === `client-deal:${dealId}`) || [];
    return { matches: client?.record?.id === clientId && client.record.ref === clientRef &&
      await textDigest(client.record.name) === partyNameDigest &&
      deal?.deal_id === dealId && deal.client_ref === clientRef &&
      await textDigest(deal.client_name) === partyNameDigest &&
      await textDigest(deal.name) === dealNameDigestExpected &&
      network?.schema === 'carr-relationship-network.v1' && Number.isFinite(observed) && Number.isFinite(valid) &&
      observed <= now && now - observed <= spec.party_reuse.fresh_network_max_age_ms &&
      valid > now && valid > observed && valid - observed <= 61_000 &&
      partyNodes.length === 1 && partyNodes[0].record_id === clientId && partyNodes[0].kind === 'client' &&
      await textDigest(partyNodes[0].name) === partyNameDigest &&
      dealNodes.length === 1 && dealNodes[0].record_id === dealId && dealNodes[0].kind === 'deal' &&
      await textDigest(dealNodes[0].name) === dealNameDigestExpected &&
      edges.length === 1 && edges[0].kind === 'client_deal' && edges[0].from === clientNodeId &&
      edges[0].to === dealNodeId && edges[0].via === null };
  }
  if (task === 'attention') {
    const board = await rpc(spec.journeys.W2.board_tool, { workspace: 'all' });
    const deal = Array.isArray(board?.deals) ? board.deals.find(row => row?.id === dealId) : null;
    return {
      board_actor_matches: board?.actor === spec.authentication.actor_slug,
      owned_attention: Boolean(deal && deal.owner === spec.authentication.actor_slug && deal.attention === true),
      plan_name_matches: Boolean(deal && await textDigest(deal.name) === dealNameDigestExpected),
    };
  }
  if (task === 'home-scope') {
    const buttons = [...document.querySelectorAll(spec.journeys.W2.scope_selector)];
    const selected = buttons.filter(button => button.getAttribute('aria-pressed') === 'true');
    const flags = [...document.querySelectorAll(spec.journeys.W2.flags_selector)];
    const owned = flags.filter(flag => flag.getAttribute('data-home-key') === `${spec.journeys.W2.flag_key_prefix}${dealId}`);
    return {
      scope: selected.length === 1 ? selected[0].getAttribute('data-scope') : null,
      flag_count: flags.length,
      owned_flag: owned.length === 1 && owned[0].getClientRects().length > 0 && owned[0].checkVisibility(),
      owned_name_matches: owned.length === 1 && await textDigest(owned[0].querySelector('strong')?.textContent) === dealNameDigestExpected,
    };
  }
  if (task === 'detail') {
    const value = await rpc(spec.journeys.W2.detail_tool, { deal: dealId });
    return { matches: value?.deal_id === dealId || value?.id === dealId };
  }
  if (task === 'relationship') {
    const response = await fetch(spec.journeys.W14.snapshot_path, {
      credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
    });
    if (!response.ok) return { snapshot: false, nodes: false, edge: false, client_ui: false, deal_ui: false };
    const network = await response.json();
    const now = Date.now(), observed = Date.parse(network?.observed_at), valid = Date.parse(network?.valid_until);
    const snapshot = network?.schema === 'carr-relationship-network.v1' && Number.isFinite(observed) && Number.isFinite(valid)
      && observed <= now && valid > now && valid > observed && now - observed <= 60_000 && valid - observed <= 61_000
      && Array.isArray(network.nodes) && Array.isArray(network.edges)
      && Array.isArray(network.referrals) && Array.isArray(network.suggestions);
    if (!snapshot) return { snapshot: false, nodes: false, edge: false, evidence: false, referrals: false, territory: false,
      client_ui: false, deal_ui: false };
    const clientNodeId = `party:${partyId}`, dealNodeId = `deal:${dealId}`;
    const clients = network.nodes.filter(node => node?.id === clientNodeId);
    const deals = network.nodes.filter(node => node?.id === dealNodeId);
    const edges = network.edges.filter(edge => edge?.id === `client-deal:${dealId}`);
    if (clients.length !== 1 || deals.length !== 1 || clients[0]?.record_id !== clientId || clients[0]?.kind !== 'client'
      || deals[0]?.record_id !== dealId || deals[0]?.kind !== 'deal')
      return { snapshot: true, nodes: false, edge: false, evidence: false, referrals: false, territory: false,
        validUntil: network.valid_until, client_ui: false, deal_ui: false };
    if (edges.length !== 1 || edges[0]?.from !== clientNodeId || edges[0]?.to !== dealNodeId
      || edges[0]?.kind !== 'client_deal' || edges[0]?.via !== null)
      return { snapshot: true, nodes: true, edge: false, evidence: false, referrals: false, territory: false,
        validUntil: network.valid_until, client_ui: false, deal_ui: false };
    const evidence = network.edges.filter(edge => edge?.id === `evidence:${partyId}:${dealId}:referred`
      && edge.from === clientNodeId && edge.to === dealNodeId && edge.via === null
      && edge.kind === 'referred' && typeof edge.detail === 'string' && edge.detail.trim().length > 0);
    const referralRows = network.referrals.filter(row => row?.node_id === clientNodeId);
    const referral = referralRows.length === 1 ? referralRows[0] : null;
    const partyNode = clients[0];
    const otherTerritoryReferrals = network.referrals.filter(row => {
      const node = network.nodes.find(value => value?.id === row?.node_id);
      return node && typeof partyNode.territory === 'string' && partyNode.territory.length > 0
        && node.territory !== partyNode.territory;
    }).length;
    const sameTerritoryReferrals = network.referrals.filter(row => {
      const node = network.nodes.find(value => value?.id === row?.node_id);
      return node && typeof partyNode.territory === 'string' && partyNode.territory.length > 0
        && node.territory === partyNode.territory;
    }).length;
    const referralValid = Boolean(referral && Number.isSafeInteger(referral.deals) && referral.deals > 0
      && Number.isSafeInteger(referral.won) && Number.isSafeInteger(referral.lost)
      && referral.won + referral.lost <= referral.deals
      && referral.win_rate === (referral.won + referral.lost ? referral.won / (referral.won + referral.lost) : null));
    return { snapshot: true, nodes: true, edge: true,
      clientNodeNameMatches: await textDigest(clients[0].name) === partyNameDigest,
      dealNameDigest: await textDigest(deals[0].name), dealNameMatches: await textDigest(deals[0].name) === dealNameDigestExpected,
      clientDealEdgeId: edges[0].id,
      evidence: evidence.length === 1,
      evidenceEdgeId: evidence.length === 1 ? evidence[0].id : null,
      evidenceDetailDigest: evidence.length === 1 ? await textDigest(evidence[0].detail) : null,
      referrals: referralValid,
      referralMetrics: referralValid ? { deals: referral.deals, won: referral.won, lost: referral.lost, win_rate: referral.win_rate } : null,
      territory: typeof partyNode.territory === 'string' ? partyNode.territory : null,
      totalReferralCount: network.referrals.length, sameTerritoryReferrals, otherTerritoryReferrals, validUntil: network.valid_until };
  }
  if (task === 'relationship-open-client') {
    const clientNodeId = `party:${partyId}`;
    const visible = node => node.getClientRects().length > 0 && node.checkVisibility();
    const targets = [...document.querySelectorAll(`[data-node="${clientNodeId}"]`)].filter(visible);
    const clientCard = targets.find(node => node.matches('.relationship-node')) || targets[0];
    if (!clientCard || typeof clientCard.click !== 'function') return { client_ui: false, deal_ui: false };
    clientCard.click();
    return { client_ui: await textDigest(document.querySelector('.relationship-dialog')?.querySelector('#relationshipTitle')?.textContent) === partyNameDigest };
  }
  if (task === 'relationship-open-deal') {
    const dealNodeId = `deal:${dealId}`;
    const dialog = document.querySelector('.relationship-dialog');
    const connection = [...(dialog?.querySelectorAll('[data-open-node]') || [])]
      .filter(button => button.getAttribute('data-card-key') === `client-deal:${dealId}`
        && button.getAttribute('data-open-node') === dealNodeId
        && button.getClientRects().length > 0 && button.checkVisibility());
    if (connection.length !== 1) return { deal_ui: false };
    connection[0].click();
    return { deal_ui: await textDigest(dialog?.querySelector('#relationshipTitle')?.textContent) === dealNameDigest };
  }
  if (task === 'theme') {
    const freshness = document.querySelector(spec.journeys.W1.freshness_selector);
    const syncAt = Date.parse(freshness?.dateTime || freshness?.getAttribute('datetime') || '');
    const freshnessCurrent = /^\d{1,2}:\d{2} (AM|PM)$/.test(freshness?.textContent?.trim() || '')
      && Number.isFinite(syncAt) && syncAt <= Date.now() + 5_000
      && Date.now() - syncAt <= spec.journeys.W1.freshness_max_age_ms;
    return {
      actor_avatar: document.querySelector(spec.journeys.W1.avatar_selector)?.getAttribute('aria-label') === "Joe: account and settings"
        && document.querySelector(spec.journeys.W1.avatar_selector)?.textContent?.trim() === 'J',
      theme: document.documentElement.getAttribute('data-theme'),
      freshness: freshnessCurrent,
    };
  }
  if (task === 'relationship-ui') {
    const clientNodeId = `party:${partyId}`;
    const dealNodeId = `deal:${dealId}`;
    const dialog = document.querySelector('.relationship-dialog');
    const selectedClient = dialog?.querySelector('#relationshipTitle');
    const evidenceEntry = evidenceEdgeId && dialog?.querySelector(`details[data-entry="${evidenceEdgeId}"]`);
    const evidenceText = evidenceEntry?.querySelector('p')?.textContent;
    const metrics = dialog?.querySelector('.relationship-metrics');
    const metricBoxes = [...(metrics?.querySelectorAll('div') || [])];
    const metricMatches = metricBoxes.length === 2 &&
      metricBoxes[0].querySelector('strong')?.textContent === String(referralMetrics?.deals) &&
      metricBoxes[0].querySelector('span')?.textContent === 'Deals sent' &&
      metricBoxes[1].querySelector('strong')?.textContent === (referralMetrics?.win_rate === null ? '—' : `${Math.round(referralMetrics?.win_rate * 100)}%`) &&
      metricBoxes[1].querySelector('span')?.textContent === `Win rate · ${referralMetrics?.won} won / ${referralMetrics?.won + referralMetrics?.lost} resolved`;
    const referralCards = [...document.querySelectorAll('#networkReferrals .relationship-referral')];
    const targetCards = referralCards.filter(card => card.getAttribute('data-node') === clientNodeId);
    const targetCard = targetCards.length === 1 ? targetCards[0] : null;
    const cardWinRate = targetCard?.querySelector('.referral-rate')?.textContent;
    const cardDetails = targetCard?.querySelector('small')?.textContent?.replace(/\s+/g, ' ').trim();
    const territoryFilter = document.querySelector(spec.journeys.W14.territory_selector);
    return {
      client_title: Boolean(selectedClient && await textDigest(selectedClient.textContent) === partyNameDigest),
      evidence_entry: Boolean(evidenceEntry?.open && await textDigest(evidenceText) === evidenceDetailDigest),
      dialog_metrics: metricMatches,
      referral_tab_selected: document.querySelector(spec.journeys.W14.referrals_tab_selector)?.getAttribute('aria-selected') === 'true',
      referral_card: Boolean(targetCard && await textDigest(targetCard.querySelector('strong')?.textContent) === partyNameDigest
        && targetCard.querySelector('b')?.textContent === String(referralMetrics?.deals)
        && cardWinRate === (referralMetrics?.win_rate === null ? '—' : `${Math.round(referralMetrics?.win_rate * 100)}% win rate`)
        && cardDetails === `${referralMetrics?.won} won · ${referralMetrics?.lost} lost · ${referralMetrics?.deals - referralMetrics?.won - referralMetrics?.lost} open`),
      referral_count: referralCards.length,
      territory_value: territoryFilter?.value || '',
      party_node_visible: [...document.querySelectorAll(`[data-node="${clientNodeId}"]`)]
        .some(node => node.getClientRects().length > 0 && node.checkVisibility()),
      deal_node_id_matches: dealNodeId === `deal:${dealId}`,
    };
  }
  return null;
}

function runTimeoutMs(run) {
  run.check();
  return Math.max(1, Math.min(run.limits.httpTimeoutMs, run.deadline - Date.now()));
}

async function waitForPageState(page, predicate, arg, run) {
  run.check();
  const timeout = runTimeoutMs(run);
  let removeAbort = () => {};
  try {
    const waiting = page.waitForFunction(predicate, arg, { timeout, polling: 'raf' });
    const stopped = new Promise((_, reject) => {
      const signal = run.signal;
      if (!signal) return;
      const abort = () => reject(new Error('Read-only journey stopped'));
      signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', abort);
    });
    await Promise.race([waiting, stopped]);
  } catch (error) {
    run.check();
    throw error;
  } finally {
    removeAbort();
  }
  run.check();
}

const accountAndThemeReady = ({ avatarSelector, themeSelector, freshnessMaxAgeMs }) => {
  const avatar = document.querySelector(avatarSelector);
  const themes = [...document.querySelectorAll(themeSelector)];
  const freshness = document.querySelector('#appSyncTime');
  const syncedAt = Date.parse(freshness?.dateTime || freshness?.getAttribute('datetime') || '');
  const visible = element => element && element.getClientRects().length > 0 && element.checkVisibility() && !element.disabled;
  return avatar?.getAttribute('aria-label') === 'Joe: account and settings' && avatar.textContent?.trim() === 'J'
    && visible(avatar) && themes.length === 1 && visible(themes[0]) && visible(freshness)
    && /^\d{1,2}:\d{2} (AM|PM)$/.test(freshness?.textContent?.trim() || '')
    && Number.isFinite(syncedAt) && syncedAt <= Date.now() + 5_000
    && Date.now() - syncedAt <= freshnessMaxAgeMs;
};

const ownedHomeScopeReady = ({ dealId, scopeSelector, flagsSelector, scope }) => {
  const panel = document.querySelector('#dealAttention');
  const buttons = [...document.querySelectorAll(scopeSelector)];
  const selected = buttons.filter(button => button.getAttribute('aria-pressed') === 'true');
  const flags = [...document.querySelectorAll(flagsSelector)];
  return panel?.getAttribute('aria-busy') === 'false' && buttons.length === 2 && selected.length === 1
    && selected[0].getAttribute('data-scope') === scope
    && flags.some(flag => flag.getAttribute('data-home-key') === `deal:${dealId}`
      && flag.getClientRects().length > 0 && flag.checkVisibility());
};

const ownedRelationshipPageReady = ({ nodeId }) => {
  const updated = document.querySelector('#networkUpdated')?.textContent?.trim();
  return Boolean(updated && updated !== 'Updating…' && [...document.querySelectorAll('[data-node]')]
    .some(node => node.getAttribute('data-node') === nodeId && node.getClientRects().length > 0 && node.checkVisibility()));
};

const ownedRelationshipConnectionReady = ({ dealId }) => {
  const dialog = document.querySelector('.relationship-dialog');
  return [...(dialog?.querySelectorAll('[data-open-node]') || [])]
    .some(button => button.getAttribute('data-card-key') === `client-deal:${dealId}`
      && button.getAttribute('data-open-node') === `deal:${dealId}`
      && button.getClientRects().length > 0 && button.checkVisibility());
};

const ownedReferralCardReady = ({ partyId }) => [...document.querySelectorAll('#networkReferrals .relationship-referral')]
  .some(card => card.getAttribute('data-node') === `party:${partyId}`
    && card.getClientRects().length > 0 && card.checkVisibility());

const ownedTerritoryViewReady = ({ partyId, territory }) => document.querySelector('#networkTerritory')?.value === territory
  && ownedReferralCardReady({ partyId });

const ownedTerritoryResetReady = ({ partyId }) => document.querySelector('#networkTerritory')?.value === ''
  && document.querySelector('#networkSearch')?.value === '' && document.querySelector('#networkVertical')?.value === ''
  && ownedReferralCardReady({ partyId });

const sha256 = value => createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
const responseHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function verifiedPartyReuse(plan, partyId, clientId, dealId) {
  const reuse = plan.party_reuse, spec = contract.party_reuse;
  const receipt = plan.receipts?.party;
  const noCreationReceipt = receipt === undefined || (receipt && typeof receipt === 'object' &&
    !Array.isArray(receipt) && Object.keys(receipt).length === 0);
  const observed = Date.parse(reuse?.observed_at || '');
  const networkObserved = Date.parse(reuse?.network_observed_at || '');
  const now = Date.now();
  return noCreationReceipt &&
    reuse?.schema === spec.schema && reuse.state === 'verified' &&
    partyId === spec.fixture_party_id && plan.records.party.name === spec.fixture_party_name &&
    reuse.party_id === partyId && reuse.client_id === clientId && reuse.deal_id === dealId &&
    uuid(clientId) && uuid(dealId) && /^C-\d+$/.test(plan.records.client?.ref || '') &&
    spec.required_response_hashes.every(field => responseHash(reuse[field])) &&
    Number.isFinite(observed) && Number.isFinite(networkObserved) &&
    observed <= networkObserved && networkObserved <= now + 5_000;
}

function planOwnershipGap(plan, release) {
  const partyId = plan?.records?.party?.id, clientId = plan?.records?.client?.id;
  const dealId = plan?.records?.deal?.id;
  if (plan?.schema !== 'doctorcre-staging-records-plan.v1' || plan.origin !== STAGING_ORIGIN ||
      plan.state !== 'complete' || plan.inflight !== null || !uuid(plan.run) ||
      plan.release?.source_commit !== release.source_commit ||
      plan.release?.carr_source_commit !== release.carr_source_commit)
    return 'fixture-provenance-unavailable';
  if (!uuid(partyId) || typeof plan.records.party.name !== 'string' || !plan.records.party.name)
    return 'owned-plan-party-unavailable';
  if (plan.receipts?.party?.party_id !== partyId && !verifiedPartyReuse(plan, partyId, clientId, dealId))
    return plan.party_reuse ? 'owned-plan-party-reuse-unavailable' : 'owned-plan-party-receipt-unavailable';
  if (!uuid(clientId) || plan.receipts?.client?.client_id !== clientId)
    return 'owned-plan-client-receipt-unavailable';
  if (!uuid(dealId) || typeof plan.records.deal.name !== 'string' || !plan.records.deal.name ||
      plan.receipts?.deal?.deal_id !== dealId)
    return 'owned-plan-deal-receipt-unavailable';
  return null;
}

function safeRelationshipPlan(plan, release) {
  return !planOwnershipGap(plan, release)
    ? { partyId: plan.records.party.id, clientId: plan.records.client.id, dealId: plan.records.deal.id } : null;
}

export async function runReadonlyJourneys({ page, release, plan, run } = {}) {
  run = requireSupervisedRun(undefined, run);
  run.check();
  if (!page || typeof page.context !== 'function' || !release || !commit(release.source_commit) ||
      release.carr_source_commit !== contract.producer.source_commit ||
      release.service !== contract.app.service || release.environment !== contract.app.environment ||
      new URL(page.url()).origin !== STAGING_ORIGIN || new URL(page.url()).pathname !== '/')
    throw new Error('Read-only journey source or guarded page refused');
  await assertStagingContextCoverage(page.context());

  const results = [];
  const actions = [];
  const sourcePair = { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit };
  const observe = (id, caseId, action, ui, readback) => {
    if (uuid(plan?.run)) actions.push(observedV1Action({ id, case: caseId, action,
      sourcePair, runId: run.snapshot().id, fixtureRun: plan.run, ui, readback }));
  };
  const provenance = { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit,
    run: uuid(plan?.run) ? plan.run : null };
  let moduleReads = 0, httpGets = 0, mcpReads = 0;
  const evaluate = async (task, args = {}) => {
    run.check();
    const cost = task === 'identity' ? [3, 0] : task === 'party-reuse-live' ? [2, 1]
      : task === 'relationship' ? [1, 0] : task === 'attention' ? [0, 1] : task === 'detail' ? [0, 1] : [0, 0];
    if (moduleReads + cost[0] + cost[1] > contract.limits.module_api_reads_max ||
        httpGets + cost[0] > contract.limits.http_gets_max || mcpReads + cost[1] > contract.limits.mcp_reads_max)
      throw new Error('Read-only journey read cap refused');
    moduleReads += cost[0] + cost[1]; httpGets += cost[0]; mcpReads += cost[1];
    try { return await page.evaluate(browserRead, { task, ...args, contract }); }
    catch { return null; }
  };

  const identity = await evaluate('identity');
  const sessionMatches = stagingAuth.session.matches({ actor: { slug: identity?.session?.actor_slug }, e2e_principal: identity?.session?.e2e_principal });
  const sourceMatches = identity?.release?.service === contract.app.service && identity.release.environment === contract.app.environment
    && identity.release.source_commit === release.source_commit &&
    (identity.release.carr_source_commit === undefined || identity.release.carr_source_commit === contract.producer.source_commit);
  const identityQualified = sourceMatches && sessionMatches && identity?.actor_slug === contract.authentication.actor_slug;
  if (!identityQualified) {
    results.push(pending('W1', 'authenticated-source-pair-unavailable'));
  } else {
    observe('W1', 'shell', 'identity', { avatar: 'joe', route: '/' },
      { release: sourcePair, actor: identity.actor_slug, principal: identity.session.e2e_principal });
    let themePersisted = false;
    try {
      await waitForPageState(page, accountAndThemeReady, {
        avatarSelector: contract.journeys.W1.avatar_selector, themeSelector: contract.journeys.W1.theme_selector,
        freshnessMaxAgeMs: contract.journeys.W1.freshness_max_age_ms,
      }, run);
      const before = await evaluate('theme');
      if (before?.actor_avatar === true && before.freshness === true)
        observe('W1', 'shell', 'freshness', { avatar: true, sync_time_visible: true },
          { fresh_sync_time: true, release: sourcePair });
      const themeControl = page.locator(contract.journeys.W1.theme_selector);
      if (before?.actor_avatar && before?.freshness === true && ['dark', 'light'].includes(before.theme) && await themeControl.count() === 1) {
        await themeControl.click({ timeout: runTimeoutMs(run) });
        const changed = await evaluate('theme');
        if (changed?.theme !== before.theme && changed?.freshness === true && ['dark', 'light'].includes(changed?.theme)) {
          run.check();
          await page.reload({ waitUntil: 'domcontentloaded', timeout: runTimeoutMs(run) });
          await waitForPageState(page, accountAndThemeReady, {
            avatarSelector: contract.journeys.W1.avatar_selector, themeSelector: contract.journeys.W1.theme_selector,
            freshnessMaxAgeMs: contract.journeys.W1.freshness_max_age_ms,
          }, run);
          const after = await evaluate('theme');
          themePersisted = after?.actor_avatar === true && after.freshness === true && after.theme === changed.theme;
          if (themePersisted) observe('W1', 'shell', 'theme-reload',
            { before: before.theme, changed: changed.theme, reloaded: after.theme },
            { actor: identity.actor_slug, fresh_sync_time: after.freshness, release: sourcePair });
        }
      }
    } catch { run.check(); }
    const lifecycle = themePersisted && page.context().browser?.()?.newContext
      ? await qualifySessionJourney({ parentPage: page, release, run }) : null;
    const lifecycleQualified = themePersisted && lifecycle?.state === 'qualified';
    if (lifecycleQualified) {
      observe('W1', 'session', 'signed-in-session',
        { signed_in_ui: lifecycle.signed_in_ui, independent_cookie: lifecycle.independent_cookie },
        { independent_csrf: lifecycle.independent_csrf, actor: identity.actor_slug, release: sourcePair });
      observe('W1', 'session', 'signout-token',
        { signed_out_ui: lifecycle.signed_out_ui, dedicated_signout: lifecycle.dedicated_signout },
        { independent_csrf: lifecycle.independent_csrf, parent_retained: lifecycle.parent_session_retained });
      observe('W1', 'session', 'old-session-rejected',
        { signed_out_ui: lifecycle.signed_out_ui },
        { old_session_rejected: lifecycle.old_session_rejected, parent_retained: lifecycle.parent_session_retained });
    }
    results.push(lifecycleQualified
      ? { journey: 'W1', state: 'qualified-slice', reason: 'fresh-shell-and-isolated-session-lifecycle-proved' }
      : pending('W1', !themePersisted ? 'avatar-freshness-or-theme-persistence-unproved'
        : lifecycle?.reason || contract.journeys.W1.pending_reason));
    Object.assign(results.at(-1), { avatar: identity?.actor_slug === contract.authentication.actor_slug,
      freshness_theme_controls_after_reload: themePersisted, isolated_sign_in_sign_out: lifecycleQualified,
      old_session_rejected: lifecycle?.old_session_rejected === true,
      parent_session_retained: lifecycle?.parent_session_retained === true,
      signed_out_ui: lifecycle?.signed_out_ui === true });
  }

  const ownershipGap = planOwnershipGap(plan, release);
  const partyReused = !ownershipGap && plan.receipts?.party?.party_id !== plan.records.party.id;
  const freshReuse = partyReused && identityQualified ? await evaluate('party-reuse-live', {
    partyId: plan.records.party.id, clientId: plan.records.client.id, dealId: plan.records.deal.id,
    clientRef: plan.records.client.ref, partyNameDigest: sha256(plan.records.party.name),
    dealNameDigestExpected: sha256(plan.records.deal.name),
  }) : null;
  const currentOwnershipGap = ownershipGap || (partyReused && freshReuse?.matches !== true
    ? 'fresh-party-reuse-association-unavailable' : null);
  const ownedDeal = !currentOwnershipGap ? plan.records.deal.id : null;
  if (!identityQualified) {
    results.push(pending('W2', 'authenticated-source-pair-unavailable'));
  } else if (currentOwnershipGap) {
    results.push(pending('W2', currentOwnershipGap));
  } else {
    const expectedDealNameDigest = sha256(plan.records.deal.name);
    const attention = await evaluate('attention', { dealId: ownedDeal, dealNameDigestExpected: expectedDealNameDigest });
    if (attention?.board_actor_matches !== true) {
      results.push(pending('W2', 'fresh-board-actor-mismatch'));
    } else if (attention?.owned_attention !== true) {
      results.push(pending('W2', contract.journeys.W2.pending_reason));
    } else if (attention?.plan_name_matches !== true) {
      results.push(pending('W2', 'owned-plan-deal-name-readback-unproved'));
    } else {
      let home = null, teamBefore = null, mine = null, teamAfter = null;
      try {
        await page.goto(`${STAGING_ORIGIN}${contract.journeys.W2.route}`, { waitUntil: 'domcontentloaded', timeout: runTimeoutMs(run) });
        await page.waitForURL(url => url.origin === STAGING_ORIGIN && url.pathname === contract.journeys.W2.route,
          { timeout: runTimeoutMs(run) });
        const homeReady = scope => waitForPageState(page, ownedHomeScopeReady, {
          dealId: ownedDeal, scopeSelector: contract.journeys.W2.scope_selector,
          flagsSelector: contract.journeys.W2.flags_selector, scope,
        }, run);
        await homeReady('team');
        teamBefore = await evaluate('home-scope', { dealId: ownedDeal, dealNameDigestExpected: expectedDealNameDigest });
        await page.locator(`${contract.journeys.W2.scope_selector}[data-scope="mine"]`).click({ timeout: runTimeoutMs(run) });
        await homeReady('mine');
        mine = await evaluate('home-scope', { dealId: ownedDeal, dealNameDigestExpected: expectedDealNameDigest });
        await page.locator(`${contract.journeys.W2.scope_selector}[data-scope="team"]`).click({ timeout: runTimeoutMs(run) });
        await homeReady('team');
        teamAfter = await evaluate('home-scope', { dealId: ownedDeal, dealNameDigestExpected: expectedDealNameDigest });
        const scopeWorked = teamBefore?.scope === 'team' && mine?.scope === 'mine' && teamAfter?.scope === 'team'
          && teamBefore?.owned_flag === true && mine?.owned_flag === true && teamAfter?.owned_flag === true
          && [teamBefore, mine, teamAfter].every(value => value?.owned_name_matches === true)
          && teamBefore?.flag_count > mine?.flag_count && teamAfter?.flag_count === teamBefore?.flag_count;
        if (!scopeWorked) throw new Error('Home scope result set or reset was not independently observed');
        observe('W2', 'home-attention', 'team-scope',
          { route: '/', scope: teamBefore.scope, flag_count: teamBefore.flag_count, owned_flag: teamBefore.owned_flag },
          { owned_deal_name_digest: expectedDealNameDigest, attention });
        observe('W2', 'home-attention', 'viewer-scope',
          { route: '/', scope: mine.scope, flag_count: mine.flag_count, owned_flag: mine.owned_flag },
          { owned_deal_name_digest: expectedDealNameDigest, attention });
        observe('W2', 'home-attention', 'scope-reset',
          { route: '/', scope: teamAfter.scope, flag_count: teamAfter.flag_count, owned_flag: teamAfter.owned_flag },
          { team_before_count: teamBefore.flag_count, owned_deal_name_digest: expectedDealNameDigest });
        const flagSelector = `${contract.journeys.W2.flags_selector}[data-home-key="${contract.journeys.W2.flag_key_prefix}${ownedDeal}"]`;
        const row = page.locator(flagSelector);
        if (await row.count() !== 1) throw new Error('Owned Home flag was not unique');
        await row.click({ timeout: runTimeoutMs(run) });
        await page.waitForURL(url => url.origin === STAGING_ORIGIN && url.pathname === '/deals' && url.searchParams.get('deal') === ownedDeal,
          { timeout: runTimeoutMs(run) });
        await page.locator('#recordPanel').waitFor({ state: 'visible', timeout: runTimeoutMs(run) });
        await page.locator('#detailPhase').waitFor({ state: 'visible', timeout: runTimeoutMs(run) });
        const detail = await evaluate('detail', { dealId: ownedDeal });
        home = detail?.matches === true;
        if (home) observe('W2', 'home-attention', 'exact-deal-open',
          { route: '/deals', panel_visible: true, owned_flag: true },
          { deal_id: ownedDeal, deal_name_digest: expectedDealNameDigest, detail });
      } catch { run.check(); }
      results.push(home === true
        ? { journey: 'W2', state: 'qualified-slice', reason: 'owned-home-scope-switch-reset-and-deal-detail-matched',
          team_scope: true, viewer_scope: true, scope_reset: true, owned_flag: true, independent_detail_readback: true }
        : pending('W2', 'owned-home-scope-or-deal-detail-interaction-unproved'));
    }
  }

  results.push(pending('W5', contract.journeys.W5.pending_reason));
  const relationshipPlan = !currentOwnershipGap ? safeRelationshipPlan(plan, release) : null;
  if (!identityQualified) {
    results.push(pending('W14', 'authenticated-source-pair-unavailable'));
  } else if (!relationshipPlan) {
    results.push(pending('W14', currentOwnershipGap));
  } else {
    const partyNameDigest = sha256(plan.records.party.name);
    const expectedDealNameDigest = sha256(plan.records.deal.name);
    let relationship = null, originalEntry = false, dialogMetrics = false, referralCard = false;
    let territoryFiltered = false, territoryReset = false, clientOpened = false, dealOpened = false;
    try {
      run.check();
      await page.goto(`${STAGING_ORIGIN}${contract.journeys.W14.route}`, { waitUntil: 'domcontentloaded', timeout: runTimeoutMs(run) });
      await page.waitForURL(url => url.origin === STAGING_ORIGIN && url.pathname === contract.journeys.W14.route, { timeout: runTimeoutMs(run) });
      await waitForPageState(page, ownedRelationshipPageReady, { nodeId: `party:${relationshipPlan.partyId}` }, run);
      relationship = await evaluate('relationship', { ...relationshipPlan, partyNameDigest,
        dealNameDigestExpected: expectedDealNameDigest });
      if (relationship?.snapshot === true && relationship?.nodes === true && relationship?.edge === true
        && relationship?.clientNodeNameMatches === true && relationship?.dealNameMatches === true) {
        if (Date.parse(relationship.validUntil) <= Date.now()) {
          relationship = { snapshot: false };
        } else {
          const openParty = await evaluate('relationship-open-client', { ...relationshipPlan, partyNameDigest });
          clientOpened = openParty?.client_ui === true;
          if (clientOpened) {
            await page.locator('.relationship-dialog').waitFor({ state: 'visible', timeout: runTimeoutMs(run) });
            const evidenceRow = relationship.evidenceEdgeId
              ? page.locator(`.relationship-dialog details[data-entry="${relationship.evidenceEdgeId}"] summary`) : null;
            if (relationship.evidence === true && evidenceRow && await evidenceRow.count() === 1) {
              await evidenceRow.click({ timeout: runTimeoutMs(run) });
              const ui = await evaluate('relationship-ui', { ...relationshipPlan, partyNameDigest,
                evidenceEdgeId: relationship.evidenceEdgeId, evidenceDetailDigest: relationship.evidenceDetailDigest,
                referralMetrics: relationship.referralMetrics });
              originalEntry = ui?.client_title === true && ui?.evidence_entry === true;
              dialogMetrics = ui?.dialog_metrics === true;
            }
            await page.locator('.relationship-dialog [data-close-card]').click({ timeout: runTimeoutMs(run) });
            await page.locator('.relationship-dialog').waitFor({ state: 'hidden', timeout: runTimeoutMs(run) });
          }
          await page.locator(contract.journeys.W14.referrals_tab_selector).click({ timeout: runTimeoutMs(run) });
          await waitForPageState(page, ownedReferralCardReady, { partyId: relationshipPlan.partyId }, run);
          const referralsUi = await evaluate('relationship-ui', { ...relationshipPlan, partyNameDigest,
            evidenceEdgeId: relationship.evidenceEdgeId, evidenceDetailDigest: relationship.evidenceDetailDigest,
            referralMetrics: relationship.referralMetrics });
          referralCard = relationship.referrals === true && referralsUi?.referral_tab_selected === true
            && referralsUi?.referral_card === true;
          const territory = relationship.territory;
          if (relationship.referrals === true && typeof territory === 'string' && territory.length > 0
            && relationship.otherTerritoryReferrals > 0 && relationship.sameTerritoryReferrals > 0) {
            const before = referralsUi?.referral_count;
            await page.locator(contract.journeys.W14.territory_selector).selectOption(territory, { timeout: runTimeoutMs(run) });
            await waitForPageState(page, ownedTerritoryViewReady, { partyId: relationshipPlan.partyId, territory }, run);
            const filtered = await evaluate('relationship-ui', { ...relationshipPlan, partyNameDigest,
              evidenceEdgeId: relationship.evidenceEdgeId, evidenceDetailDigest: relationship.evidenceDetailDigest,
              referralMetrics: relationship.referralMetrics });
            territoryFiltered = filtered?.territory_value === territory
              && filtered?.referral_card === true
              && filtered?.referral_count === relationship.sameTerritoryReferrals
              && filtered.referral_count < before;
            await page.locator(contract.journeys.W14.reset_selector).click({ timeout: runTimeoutMs(run) });
            await waitForPageState(page, ownedTerritoryResetReady, { partyId: relationshipPlan.partyId }, run);
            const reset = await evaluate('relationship-ui', { ...relationshipPlan, partyNameDigest,
              evidenceEdgeId: relationship.evidenceEdgeId, evidenceDetailDigest: relationship.evidenceDetailDigest,
              referralMetrics: relationship.referralMetrics });
            territoryReset = reset?.territory_value === '' && reset?.referral_count === relationship.totalReferralCount
              && reset?.referral_card === true;
          }
          await page.locator('#graphTab').click({ timeout: runTimeoutMs(run) });
          await waitForPageState(page, ownedRelationshipPageReady, { nodeId: `party:${relationshipPlan.partyId}` }, run);
          const reopened = await evaluate('relationship-open-client', { ...relationshipPlan, partyNameDigest });
          clientOpened = clientOpened && reopened?.client_ui === true;
          if (clientOpened) {
            await waitForPageState(page, ownedRelationshipConnectionReady, { dealId: relationshipPlan.dealId }, run);
            const dealUi = await evaluate('relationship-open-deal', { ...relationshipPlan,
              dealNameDigest: relationship.dealNameDigest });
            dealOpened = dealUi?.deal_ui === true;
          }
        }
      }
    } catch { run.check(); }
    let relationshipReason = relationship?.snapshot !== true || !Number.isFinite(Date.parse(relationship?.validUntil))
      || Date.parse(relationship.validUntil) <= Date.now() ? 'fresh-relationship-snapshot-unavailable'
      : relationship?.nodes !== true || relationship?.clientNodeNameMatches === false || relationship?.dealNameMatches === false
        ? 'owned-relationship-nodes-unavailable'
        : relationship?.edge !== true ? 'owned-client-deal-edge-unavailable'
          : relationship?.evidence !== true || originalEntry !== true ? 'owned-party-evidence-entry-unavailable'
            : relationship?.referrals !== true || referralCard !== true || dialogMetrics !== true
              ? 'owned-party-referral-metrics-unavailable'
              : territoryFiltered !== true || territoryReset !== true ? 'territory-filter-effect-unavailable'
                : clientOpened !== true || dealOpened !== true ? 'owned-relationship-detail-interaction-unproved' : null;
    const freshAssociation = relationship?.snapshot === true && relationship.nodes === true &&
      relationship.edge === true && relationship.clientNodeNameMatches === true &&
      relationship.dealNameMatches === true && Date.parse(relationship.validUntil) > Date.now();
    if (freshAssociation && originalEntry)
      observe('W14', 'relationships', 'owned-party-evidence',
        { client_dialog: true, original_entry_expanded: true, entry_digest: relationship.evidenceDetailDigest },
        { party_id: relationshipPlan.partyId, client_id: relationshipPlan.clientId,
          evidence_edge: relationship.evidenceEdgeId, client_deal_edge: relationship.clientDealEdgeId });
    if (freshAssociation && dialogMetrics && referralCard)
      observe('W14', 'relationships', 'referrals',
        { referral_tab: true, owned_card: true, metrics: relationship.referralMetrics },
        { node_id: relationshipPlan.partyId, total_referrals: relationship.totalReferralCount });
    if (freshAssociation && territoryFiltered)
      observe('W14', 'relationships', 'territory-filter',
        { selected: relationship.territory, owned_card: true },
        { same_territory: relationship.sameTerritoryReferrals,
          other_territory: relationship.otherTerritoryReferrals });
    if (freshAssociation && territoryReset)
      observe('W14', 'relationships', 'territory-reset',
        { selected: '', owned_card: true },
        { restored_count: relationship.totalReferralCount, node_id: relationshipPlan.partyId });
    results.push(relationshipReason
      ? { ...pending('W14', relationshipReason), party_node: relationship?.nodes === true,
        client_deal_edge: relationship?.edge === true, original_entry: originalEntry,
        referral_metrics: dialogMetrics && referralCard, territory_filter_reset: territoryFiltered && territoryReset,
        client_navigation: clientOpened, deal_navigation: dealOpened }
      : { journey: 'W14', state: 'qualified-slice', reason: 'owned-party-evidence-referral-territory-and-navigation-matched',
        party_node: true, client_deal_edge: true, original_entry: true, referral_metrics: true,
        territory_filter_reset: true, client_navigation: true, deal_navigation: true });
  }
  run.check();
  await assertStagingContextCoverage(page.context());
  return {
    schema: 'staging-readonly-journey-result.v1',
    provenance,
    counts: { qualified_slices: results.filter(row => row.state === 'qualified-slice').length,
      pending_slices: results.filter(row => row.state === 'pending').length, module_api_reads: moduleReads,
      http_gets: httpGets, mcp_reads: mcpReads, carr_record_mutations: 0 },
    journeys: results,
    actions,
    full_v1_qualified: false,
  };
}
