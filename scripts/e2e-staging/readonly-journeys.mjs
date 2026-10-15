import contract from '../../contracts/e2e-staging-readonly-journeys.v1.json' with { type: 'json' };
import { requireSupervisedRun } from './run-limits.mjs';
import { STAGING_ORIGIN } from './session.mjs';
import { stagingAuth } from './auth-contract.mjs';
import { assertStagingContextCoverage } from './engine.mjs';

const commit = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const pending = (journey, reason) => ({ journey, state: 'pending', reason });

// This function is serialized into the guarded page. Its only network path is
// same-origin fetch, so installStagingGuard remains the sole HTTP policy/meter.
async function browserRead({ task, dealId, partyId, clientId, contract: spec }) {
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
  if (task === 'attention') {
    const [board, triage] = await Promise.all([
      rpc(spec.journeys.W2.board_tool, { workspace: 'all' }),
      rpc('today-triage'),
    ]);
    const deal = Array.isArray(board?.deals) ? board.deals.find(row => row?.id === dealId) : null;
    return {
      board_actor_matches: board?.actor === spec.authentication.actor_slug,
      owned_attention: Boolean(deal && deal.owner === spec.authentication.actor_slug && deal.attention === true),
      triage_shape_valid: Array.isArray(triage?.items),
    };
  }
  if (task === 'attention-ui') {
    const hasDeal = selector => [...(document.querySelector(selector)?.querySelectorAll('[data-layout-deal]') || [])]
      .some(row => row.getAttribute('data-layout-deal') === dealId);
    return { working: hasDeal(spec.journeys.W2.working_selector), today: hasDeal(spec.journeys.W2.today_selector) };
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
      && Array.isArray(network.nodes) && Array.isArray(network.edges);
    if (!snapshot) return { snapshot: false, nodes: false, edge: false, client_ui: false, deal_ui: false };
    const clientNodeId = `party:${partyId}`, dealNodeId = `deal:${dealId}`;
    const clients = network.nodes.filter(node => node?.id === clientNodeId);
    const deals = network.nodes.filter(node => node?.id === dealNodeId);
    const edges = network.edges.filter(edge => edge?.id === `client-deal:${dealId}`);
    if (clients.length !== 1 || deals.length !== 1 || clients[0]?.record_id !== clientId || clients[0]?.kind !== 'client'
      || deals[0]?.record_id !== dealId || deals[0]?.kind !== 'deal')
      return { snapshot: true, nodes: false, edge: false, client_ui: false, deal_ui: false };
    if (edges.length !== 1 || edges[0]?.from !== clientNodeId || edges[0]?.to !== dealNodeId
      || edges[0]?.kind !== 'client_deal' || edges[0]?.via !== null)
      return { snapshot: true, nodes: true, edge: false, client_ui: false, deal_ui: false };
    const dialog = document.querySelector('.relationship-dialog');
    const clientCard = document.querySelector(`.relationship-node[data-node="${clientNodeId}"]`)
      || document.querySelector(`[data-node="${clientNodeId}"]`);
    if (!clientCard || typeof clientCard.click !== 'function') return { snapshot: true, nodes: true, edge: true, client_ui: false, deal_ui: false };
    clientCard.click();
    const clientTitleMatches = dialog?.querySelector('#relationshipTitle')?.textContent === clients[0].name;
    const connection = [...(dialog?.querySelectorAll('[data-open-node]') || [])]
      .filter(button => button.getAttribute('data-open-node') === dealNodeId);
    if (!clientTitleMatches || connection.length !== 1) return { snapshot: true, nodes: true, edge: true, client_ui: false, deal_ui: false };
    connection[0].click();
    return { snapshot: true, nodes: true, edge: true, client_ui: true,
      deal_ui: dialog?.querySelector('#relationshipTitle')?.textContent === deals[0].name };
  }
  if (task === 'theme') {
    return {
      actor_avatar: document.querySelector(spec.journeys.W1.avatar_selector)?.getAttribute('aria-label') === "Joe: account and settings"
        && document.querySelector(spec.journeys.W1.avatar_selector)?.textContent?.trim() === 'J',
      theme: document.documentElement.getAttribute('data-theme'),
    };
  }
  return null;
}

function safePlan(plan, release) {
  const partyId = plan?.records?.party?.id, clientId = plan?.records?.client?.id;
  const dealId = plan?.records?.deal?.id;
  return plan?.schema === 'doctorcre-staging-records-plan.v1' && plan.origin === STAGING_ORIGIN
    && plan.state === 'complete' && plan.inflight === null && uuid(plan.run)
    && uuid(partyId) && uuid(clientId)
    && plan.receipts?.party?.party_id === partyId && plan.receipts?.client?.client_id === clientId
    && uuid(dealId) && plan.receipts?.deal?.deal_id === dealId
    && plan.release?.source_commit === release.source_commit
    && plan.release?.carr_source_commit === release.carr_source_commit;
}

function safeRelationshipPlan(plan, release) {
  return safePlan(plan, release)
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
  const provenance = { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit,
    run: uuid(plan?.run) ? plan.run : null };
  let moduleReads = 0, httpGets = 0, mcpReads = 0;
  const evaluate = async (task, args = {}) => {
    run.check();
    const cost = task === 'identity' ? [3, 0] : task === 'relationship' ? [2, 0] : task === 'attention' ? [0, 2] : task === 'detail' ? [0, 1] : [0, 0];
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
    && identity.release.source_commit === release.source_commit && identity.release.carr_source_commit === contract.producer.source_commit;
  const identityQualified = sourceMatches && sessionMatches && identity?.actor_slug === contract.authentication.actor_slug;
  if (!identityQualified) {
    results.push(pending('W1', 'authenticated-source-pair-unavailable'));
  } else {
    const before = await evaluate('theme');
    let themePersisted = false;
    try {
      const themeControl = page.locator(contract.journeys.W1.theme_selector);
      if (before?.actor_avatar && ['dark', 'light'].includes(before.theme) && await themeControl.count() === 1) {
        await themeControl.click({ timeout: run.limits.httpTimeoutMs });
        const changed = await evaluate('theme');
        if (changed?.theme !== before.theme && ['dark', 'light'].includes(changed?.theme)) {
          run.check();
          await page.reload({ waitUntil: 'domcontentloaded', timeout: run.limits.httpTimeoutMs });
          await page.waitForFunction(() => document.querySelector('#selfAvatar')?.getAttribute('aria-label') === "Joe: account and settings",
            undefined, { timeout: run.limits.httpTimeoutMs });
          const after = await evaluate('theme');
          themePersisted = after?.actor_avatar === true && after.theme === changed.theme;
        }
      }
    } catch { run.check(); }
    results.push(themePersisted
      ? { journey: 'W1', state: 'qualified-slice', reason: 'authenticated-avatar-and-theme-persisted', avatar: true, theme_persisted: true,
        pending: ['signout-post'] }
      : pending('W1', 'avatar-or-theme-persistence-unproved'));
  }

  const ownedDeal = safePlan(plan, release) && uuid(plan.records?.deal?.id) ? plan.records.deal.id : null;
  if (!identityQualified) {
    results.push(pending('W2', 'authenticated-source-pair-unavailable'));
  } else if (!ownedDeal) {
    results.push(pending('W2', 'owned-plan-deal-unavailable'));
  } else {
    const attention = await evaluate('attention', { dealId: ownedDeal });
    if (attention?.board_actor_matches !== true) {
      results.push(pending('W2', 'fresh-board-actor-mismatch'));
    } else if (attention?.owned_attention !== true) {
      results.push(pending('W2', contract.journeys.W2.pending_reason));
    } else if (attention?.triage_shape_valid !== true) {
      results.push(pending('W2', 'fresh-today-triage-unavailable'));
    } else {
      const ui = await evaluate('attention-ui', { dealId: ownedDeal });
      if (ui?.working !== true || ui?.today !== true) {
        results.push(pending('W2', 'current-attention-panels-do-not-show-owned-deal'));
      } else {
        const rowSelector = `${contract.journeys.W2.working_selector} ${contract.journeys.W2.deal_selector}[data-layout-deal="${ownedDeal}"]`;
        try {
          const row = page.locator(rowSelector);
          if (await row.count() !== 1) {
            results.push(pending('W2', 'owned-deal-attention-row-not-unique'));
          } else {
            await row.click({ timeout: run.limits.httpTimeoutMs });
            await page.waitForURL(url => url.origin === STAGING_ORIGIN && ['/', '/deals'].includes(url.pathname) && url.searchParams.get('deal') === ownedDeal,
              { timeout: run.limits.httpTimeoutMs });
            await page.locator('#recordPanel').waitFor({ state: 'visible', timeout: run.limits.httpTimeoutMs });
            await page.locator('#detailPhase').waitFor({ state: 'visible', timeout: run.limits.httpTimeoutMs });
            const detail = await evaluate('detail', { dealId: ownedDeal });
            results.push(detail?.matches === true
              ? { journey: 'W2', state: 'qualified-slice', reason: 'owned-attention-row-opened-and-detail-readback-matched',
                working_list: true, today_needs: true, independent_detail_readback: true }
              : pending('W2', 'independent-deal-detail-readback-unproved'));
          }
        } catch { run.check(); results.push(pending('W2', 'owned-attention-detail-interaction-unproved')); }
      }
    }
  }

  results.push(pending('W5', contract.journeys.W5.pending_reason));
  const relationshipPlan = safeRelationshipPlan(plan, release);
  if (!identityQualified) {
    results.push(pending('W14', 'authenticated-source-pair-unavailable'));
  } else if (!relationshipPlan) {
    results.push(pending('W14', 'owned-party-client-deal-receipts-unavailable'));
  } else {
    let relationship = null;
    try {
      run.check();
      await page.goto(`${STAGING_ORIGIN}${contract.journeys.W14.route}`, { waitUntil: 'domcontentloaded', timeout: run.limits.httpTimeoutMs });
      await page.waitForURL(url => url.origin === STAGING_ORIGIN && url.pathname === contract.journeys.W14.route, { timeout: run.limits.httpTimeoutMs });
      relationship = await evaluate('relationship', relationshipPlan);
    } catch { run.check(); }
    results.push(relationship?.snapshot !== true
      ? pending('W14', 'fresh-relationship-snapshot-unavailable')
      : relationship?.nodes !== true
        ? pending('W14', 'owned-relationship-nodes-unavailable')
        : relationship?.edge !== true
          ? pending('W14', 'owned-client-deal-edge-unavailable')
          : relationship?.client_ui !== true || relationship?.deal_ui !== true
            ? pending('W14', 'owned-relationship-detail-interaction-unproved')
            : { journey: 'W14', state: 'qualified-slice', reason: 'owned-client-deal-association-and-detail-readback-matched',
              client_node: true, deal_node: true, association_edge: true, relationship_detail: true });
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
    full_v1_qualified: false,
  };
}
