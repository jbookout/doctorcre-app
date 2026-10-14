import { requireSupervisedRun, effectiveRunLimits, RunLimitError } from './run-limits.mjs';
import { constants } from 'node:fs';
import { mkdir, open, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { assertStagingURL, createStagingRequestContext, stagingSession, STAGING_ORIGIN } from './session.mjs';
import { stagingAuth } from './auth-contract.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import appRoutes from '../../contracts/app-routes.v1.json' with { type: 'json' };
import { eligibleLead } from '../../js/leads-model.js';
import { COLUMNS } from '../../js/pipeline-model.js';
import { prepareBrowserControlProofs, validControlProof } from './control-proofs.mjs';
import businessJourneys from '../../contracts/e2e-staging-business-journeys.v1.json' with { type: 'json' };

const FIXTURE = { id: 'fc08d2f4-a951-5679-9f34-40d0f4278842', name: 'Synthetic Staging Fixture' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUUID = value => typeof value === 'string' && UUID.test(value);
const fail = () => { throw new Error('Staging record contract refused'); };
const requireValue = condition => { if (!condition) fail(); };
const recordId = value => { requireValue(isUUID(value || '')); return value; };

async function privateJSON(path, value, exclusive = false, run) {
  run = requireSupervisedRun(undefined, run);
  const data = JSON.stringify(value, null, 2) + '\n';
  run.reserveBytes(Buffer.byteLength(data));
  const destination = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
  if (!exclusive) await rename(destination, path);
  const directory = await open(join(path, '..'), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readPrivateJSON(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Staging records plan cannot be read safely'); }
  try {
    const stat = await handle.stat();
    requireValue(stat.isFile() && (stat.mode & 0o777) === 0o600);
    return JSON.parse(await handle.readFile('utf8'));
  } catch { throw new Error('Staging records plan requires a valid private regular file'); }
  finally { await handle.close(); }
}

export async function prepareStagingRecords(output, {
  origin = STAGING_ORIGIN, session = stagingSession, reuseOnly = false,
  requestFactory, run, signal,
} = {}) {
  signal?.throwIfAborted();
  origin = assertStagingURL(origin);
  run = requireSupervisedRun(output, run);
  signal ??= run.signal;
  const persist = (path, value, exclusive) => privateJSON(path, value, exclusive, run);
  const planPath = join(output, 'staging-records-plan.json');
  const existing = await readPrivateJSON(planPath);
  if (existing && (existing.state !== 'complete' || existing.inflight)) throw new Error('Staging records partial plan requires reconciliation; no record write was retried');
  if (reuseOnly && (!existing || existing.schema !== 'doctorcre-staging-records-plan.v1' || existing.origin !== STAGING_ORIGIN ||
      !/^[0-9a-f]{40}$/.test(existing.release?.source_commit || '') || existing.release?.carr_source_commit !== contract.producer.source_commit ||
      ['party', 'client', 'deal', 'lead_party', 'lead', 'conversation', 'tour'].some(name => !isUUID(existing.records?.[name]?.id || '')) || !isUUID(existing.records?.invoice?.deal_id || ''))) {
    throw new Error('Resume requires an existing complete private staging records plan; no record write was attempted');
  }
  const { state, release } = await session(origin, { run, signal });
  if (release?.environment !== 'staging' || release?.service !== 'doctorcre-app' ||
      !/^[0-9a-f]{40}$/.test(release?.source_commit || '') || release?.carr_source_commit !== contract.producer.source_commit) {
    throw new Error('Staging records require the exact pinned staging source pair');
  }
  const source = { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit };
  if (existing && (existing.schema !== 'doctorcre-staging-records-plan.v1' || existing.origin !== STAGING_ORIGIN ||
      existing.release?.source_commit !== source.source_commit || existing.release?.carr_source_commit !== source.carr_source_commit)) {
    throw new Error('Staging records completed plan differs from the exact source pair');
  }
  const fixtureRun = existing?.run || randomUUID();
  const label = `Synthetic staging QA ${fixtureRun}`;
  const plan = existing || {
    schema: 'doctorcre-staging-records-plan.v1', origin, release: source, state: 'pending', run: fixtureRun,
    keys: Object.fromEntries(['party', 'client', 'deal', 'deal_lead', 'invoice_deal', 'invoice_lead', 'close_invoice', 'lead_party', 'lead', 'conversation', 'tour'].map(name => [name, randomUUID()])),
    names: { deal: `${label} active deal`, invoice: `${label} closed deal`, lead: `QA Unlinked Prospect ${fixtureRun}`, conversation: `${label} private conversation`, tour: `${label} draft tour` },
    records: {}, receipts: {}, current_step: 'authentication', observed_at: new Date().toISOString(),
  };
  const controlProofs = await prepareBrowserControlProofs(source, { signal });
  plan.browser_control_proofs = controlProofs.proofs;
  plan.browser_control_proof_preparation = controlProofs.preparation;
  plan.current_step = 'authentication';
  let api, removeAbort = () => {};
  const headers = { origin: STAGING_ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  try {
    api = await createStagingRequestContext({ baseURL: origin, storageState: state, requestFactory, run });
    const abort = () => { void api.dispose().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    removeAbort = () => signal?.removeEventListener('abort', abort);
    signal?.throwIfAborted();
    async function json(path, data) {
      signal?.throwIfAborted();
      assertStagingURL(new URL(path, STAGING_ORIGIN).href);
      const options = { headers, maxRedirects: 0, ...(data === undefined ? {} : { data }) };
      const response = data === undefined ? await api.get(path, options) : await api.post(path, options);
      requireValue(response.ok());
      return response.json();
    }
    let sequence = 0;
    async function rpc(name, args = {}, notFoundDealID) {
      const answer = await json('/mcp', { jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } });
      requireValue(!answer.error);
      const text = answer.result?.content?.find(item => item.type === 'text')?.text;
      const value = JSON.parse(text);
      requireValue(value && typeof value === 'object' && !Array.isArray(value));
      if (existing && name === 'get-deal-room' && notFoundDealID && answer.result?.isError === true && value.error === 'not_found' && value.table === 'deal' && value.id === notFoundDealID) return value;
      requireValue(!answer.result?.isError && !value.error && value.ok !== false);
      return value;
    }
    const actor = await json(stagingAuth.session.path);
    requireValue(stagingAuth.session.matches(actor) && typeof actor.csrf_token === 'string' && actor.csrf_token);
    if (!existing) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      await persist(planPath, plan, true);
    }
    async function write(step, name, args) {
      signal?.throwIfAborted();
      plan.current_step = step;
      plan.inflight = { name, arguments: { ...args, idempotency_key: plan.keys[step] } };
      await persist(planPath, plan);
      signal?.throwIfAborted();
      const result = await rpc(name, plan.inflight.arguments);
      plan.receipts[step] = Object.fromEntries(['party_id', 'client_id', 'deal_id', 'lead_id', 'conversation_id'].filter(field => isUUID(result[field] || '')).map(field => [field, result[field]]));
      plan.inflight = null;
      await persist(planPath, plan);
      return result;
    }
    async function remember(name, record) { plan.records[name] = record; await persist(planPath, plan); }
    if (!existing) {
      const party = await write('party', 'add-party', { name: FIXTURE.name, kind: 'org' });
      if (party.needs_confirm) {
        const exact = party.candidates?.filter(candidate => candidate.id === FIXTURE.id && candidate.name === FIXTURE.name);
        requireValue(exact?.length === 1);
        await remember('party', FIXTURE);
      } else {
        requireValue(party.ok === true && !party.auto_resolved);
        await remember('party', { id: recordId(party.party_id), name: FIXTURE.name });
      }
      const client = await write('client', 'new-client', {
        party_id: plan.records.party.id, status: 'engaged', acquisition_source: 'referral',
        acquisition_detail: 'Explicitly fictional staging QA fixture only',
        research_evidence: {
          sources: [{ url: 'https://practice.example/about?fixture=synthetic-staging-qa-v1', observed_at: plan.observed_at }],
          field_evidence: Object.fromEntries(['practice_name', 'address', 'phone', 'specialty', 'practitioners', 'hours'].map(field => [field, [0]])),
          discrepancies: [],
        },
      });
      requireValue(client.ok === true && /^C-\d+$/.test(client.ref || ''));
      await remember('client', { id: recordId(client.client_id), ref: client.ref, name: plan.records.party.name });
      async function deal(step, name, leadStep) {
        const created = await write(step, 'new-deal', { client: client.ref, name, deal_type: 'startup', phase: 'pending', lane: 'territory', reason: 'Explicitly fictional staging QA fixture only' });
        requireValue(created.ok === true);
        const id = recordId(created.deal_id);
        await remember(step === 'deal' ? 'deal' : 'invoice', step === 'deal' ? { id, name } : { deal_id: id, name });
        const fresh = await rpc('get-deal-room', { deal: id });
        requireValue(fresh.deal_id === id && Number.isInteger(fresh.base_version));
        requireValue((await write(leadStep, 'set-lead', { deal: id, new_lead: 'joe', base_version: fresh.base_version })).ok === true);
        return { id, name };
      }
      await deal('deal', plan.names.deal, 'deal_lead');
      const invoice = await deal('invoice_deal', plan.names.invoice, 'invoice_lead');
      const fresh = await rpc('get-deal-room', { deal: invoice.id });
      requireValue(fresh.deal_id === invoice.id && Number.isInteger(fresh.base_version));
      requireValue((await write('close_invoice', 'update-deal', { deal: invoice.id, base_version: fresh.base_version, fields: { phase: 'closed' } })).ok === true);
      const leadParty = await write('lead_party', 'add-party', { name: plan.names.lead, kind: 'org' });
      requireValue(leadParty.ok === true && !leadParty.auto_resolved && !leadParty.needs_confirm);
      await remember('lead_party', { id: recordId(leadParty.party_id), name: plan.names.lead });
      const lead = await write('lead', 'new-lead', { party_id: plan.records.lead_party.id, stage: 'new', source_type: 'synthetic_staging_qa', source_detail: 'Explicitly fictional staging QA fixture only' });
      requireValue(lead.ok === true);
      await remember('lead', { id: recordId(lead.lead_id), ref: lead.ref, name: plan.names.lead });
      const conversation = await write('conversation', 'create-doc-conversation', { title: plan.names.conversation, visibility: 'private' });
      requireValue(conversation.ok === true);
      await remember('conversation', { id: recordId(conversation.conversation_id), name: plan.names.conversation });
      plan.current_step = 'tour';
      const point = role => ({ latitude: 30.4, longitude: -87.2, position_role: role, precision_class: 'approximate', source_ref: 'synthetic-staging-qa-point-v1' });
      plan.inflight = { name: 'create-tour-domain', arguments: {
        idempotency_key: plan.keys.tour, tour_name: plan.names.tour, subject_type: 'client', subject_id: plan.records.client.id,
        canonical_dataset_version: 'synthetic-staging-qa-v1', start_point: point('start'), end_point: point('end'),
      } };
      await persist(planPath, plan);
      signal?.throwIfAborted();
      const tour = await api.post('/api/tours/create', {
        maxRedirects: 0, headers: { ...headers, 'x-carr-csrf': actor.csrf_token },
        data: plan.inflight.arguments,
      });
      requireValue(tour.ok());
      await remember('tour', { id: recordId((await tour.json()).data?.tour_id), name: plan.names.tour });
      plan.inflight = null;
    }
    plan.current_step = 'readback';
    await persist(planPath, plan);
    const boundedText = value => typeof value === 'string' && value.length > 0 && value.length <= 500;
    const clientRead = await json(`/api/v1/business/clients/${plan.records.client.id}`);
    requireValue(clientRead.record?.id === plan.records.client.id && boundedText(clientRead.record.name));
    requireValue(existing || clientRead.record.name === plan.records.client.name);
    const dealView = await rpc('get-deal-room', { deal: plan.records.deal.id }, existing ? plan.records.deal.id : undefined);
    const closedDeal = dealView.error === 'not_found';
    const dealRead = closedDeal ? await rpc('read-deal-reconciliation', { deal: plan.records.deal.id }) : dealView;
    if (closedDeal) requireValue(dealRead.id === plan.records.deal.id && dealRead.phase === 'closed');
    else {
      requireValue(dealRead.deal_id === plan.records.deal.id && boundedText(dealRead.name) &&
        (dealRead.owner === null || boundedText(dealRead.owner)) && boundedText(dealRead.phase));
      requireValue(existing || (dealRead.name === plan.records.deal.name && dealRead.owner === 'joe' && dealRead.phase === 'pending'));
    }
    const invoiceRead = await rpc('read-deal-reconciliation', { deal: plan.records.invoice.deal_id });
    requireValue(invoiceRead.id === plan.records.invoice.deal_id && boundedText(invoiceRead.phase));
    const tracker = await rpc('read-invoice-tracker');
    requireValue(Array.isArray(tracker.entries));
    const invoiceVisible = tracker.entries.some(row => row.deal_id === plan.records.invoice.deal_id);
    requireValue(existing || (invoiceRead.phase === 'closed' && invoiceVisible));
    const leadRead = await rpc('lead-board', { workspace: 'leads', lead_id: plan.records.lead.id });
    requireValue(leadRead.detail?.id === plan.records.lead.id && leadRead.detail.party_id === plan.records.lead_party.id);
    const leadEligible = eligibleLead(leadRead.detail);
    requireValue(existing || leadEligible);
    const conversationRead = await rpc('read-doc-conversation', { conversation_id: plan.records.conversation.id, limit: 1 });
    requireValue(conversationRead.identity?.id === plan.records.conversation.id && boundedText(conversationRead.identity.visibility));
    requireValue(existing || conversationRead.identity.visibility === 'private');
    const tourRead = (await json(`/api/tours/detail?tour_id=${plan.records.tour.id}`)).data;
    requireValue(tourRead?.id === plan.records.tour.id && isUUID(tourRead.subject_id || '') && boundedText(tourRead.subject_type));
    requireValue(existing || (tourRead.subject_id === plan.records.client.id && tourRead.subject_type === 'client'));
    const limited = (record, reason, guidance, current = {}) => ({
      record, id: plan.records[record].id || plan.records[record].deal_id, name: plan.records[record].name,
      reason, coverage_limited: true, guidance, ...current,
    });
    const needs_restore = [
      ...(clientRead.record.name !== plan.records.client.name ? [limited('client', 'name_changed', 'Find the invented client by its current name in the normal UI, or rename it there for the remaining controls.', { current_name: clientRead.record.name })] : []),
      ...(closedDeal ? [limited('deal', 'closed', 'The original deal is closed and absent from the active Deal Room. Use the normal UI to reopen it if available, or create another invented deal for active deal controls.', boundedText(dealRead.name) ? { current_name: dealRead.name } : {})] : [
        ...(dealRead.name !== plan.records.deal.name ? [limited('deal', 'name_changed', 'Find the invented deal by its current name in the normal UI, or rename it there for the remaining controls.', { current_name: dealRead.name })] : []),
        ...(dealRead.owner !== 'joe' ? [limited('deal', 'owner_changed', 'Use the normal UI to select the current owner or assign the invented deal back to Joe for the remaining controls.', { current_owner: dealRead.owner })] : []),
        ...(dealRead.phase !== 'pending' ? [limited('deal', 'phase_changed', 'Use the normal UI to work in the current phase or return the invented deal to pending for the remaining controls.', { current_phase: dealRead.phase })] : []),
        ...(dealRead.operating_state === 'parked' ? [{ record: 'deal', id: plan.records.deal.id, name: plan.records.deal.name, reason: 'parked' }] : []),
      ]),
      ...(invoiceRead.phase !== 'closed' || !invoiceVisible ? [limited('invoice', invoiceRead.phase !== 'closed' ? 'phase_changed' : 'not_in_invoice_tracker', 'Use the normal UI to return the invented deal to closed if available, or create another invented closed deal for invoice controls.', { current_phase: invoiceRead.phase })] : []),
      ...(!leadEligible ? [{ record: 'lead', id: plan.records.lead.id, name: plan.records.lead.name, reason: 'ui_ineligible', coverage_limited: true,
        guidance: 'The original lead is ineligible for the Leads UI. Create another invented lead through the normal UI to cover lead controls.' }]
        : leadRead.detail.stage === 'archived' ? [{ record: 'lead', id: plan.records.lead.id, name: plan.records.lead.name, reason: 'archived' }] : []),
      ...(conversationRead.identity.archived_at ? [{ record: 'conversation', id: plan.records.conversation.id, name: plan.records.conversation.name, reason: 'archived' }] : []),
      ...(conversationRead.identity.visibility !== 'private' ? [limited('conversation', 'visibility_changed', 'Use the normal UI to return the invented conversation to private if available, or create another invented private conversation for those controls.', { current_visibility: conversationRead.identity.visibility })] : []),
      ...(tourRead.subject_id !== plan.records.client.id || tourRead.subject_type !== 'client' ? [limited('tour', 'subject_changed', 'Use the normal UI to select the original invented client if available, or create another invented draft tour for those controls.')] : []),
    ];
    const result = { schema: 'doctorcre-staging-records.v1', origin: STAGING_ORIGIN, release, complete: true, records: plan.records, eligibleLead: leadEligible, findings: [], needs_restore };
    await persist(join(output, 'staging-records.json'), result);
    plan.state = 'complete';
    await persist(planPath, plan);
    return result;
  } catch (error) {
    if (error instanceof RunLimitError) throw error;
    signal?.throwIfAborted();
    run?.check();
    throw new Error(`Staging records setup stopped at ${plan.current_step}; partial plan requires reconciliation; no request or provider payload was logged`);
  } finally { removeAbort(); if (api) await api.dispose().catch(() => {}); }
}

const browserReads = new Set(["capture-queue", "correspondence-readiness", "current-work-item", "deal-room-board", "engineering-passport", "find", "find-and-catch-up", "get-call-context", "get-deal-room", "get-incident", "governance-queue", "incident-board", "lead-board", "list-doc-conversations", "list-doc-suggestions", "list-feature-switches", "list-industry-events", "list-my-codex-sessions", "list-progress-boards", "loop-board", "loop-headers", "morning-brief", "notification-feed", "read-assurance-health", "read-correspondence-thread", "read-dispatch-history", "read-doc-activity", "read-doc-conversation", "read-doc-outcome-cards", "read-invoice-tracker", "read-loop", "read-notification-preferences", "read-portfolio", "read-progress-board", "read-resource-dashboard", "read-room", "read-room-queue", "read-session-identity", "schedule-board", "today-triage", "unfinished-work", "work-request-card"]);

// Known app documents, audited HTTP reads and exact built static assets only.
// API and auth prefixes are deliberately not read grants.
const browserPages = new Set([...Object.keys(appRoutes.routes), ...Object.keys(appRoutes.redirects || {})]);
const httpReads = new Set([
  stagingAuth.session.path, '/app-release', '/pipeline/changes', '/api/call-context',
  '/api/v1/command-center', '/api/v1/work-inventory', '/api/v1/atlas-graph', '/api/v1/jev-deal-reading',
  '/api/v1/business/clients', '/api/v1/business/vendors', '/api/v1/business/leases', '/api/v1/business/relationships',
  '/api/room/turns', '/api/room/queue', '/api/system-work/session', '/api/system-work/current',
  '/api/tours/library', '/api/tours/detail', '/api/tours/selection-cart', '/api/tours/property-evidence/v1',
  '/api/tours/feedback', '/api/tours/projection/candidates',
]);
let builtStaticPaths;
const builtStaticFiles = new Map();
export async function assertStagingBrowserInventory() {
  builtStaticPaths ||= readFile(fileURLToPath(new URL('../../dist/doctorcre-app.manifest.json', import.meta.url)), 'utf8')
    .then(text => {
      const manifest = JSON.parse(text);
      if (manifest?.schema !== 'doctorcre-static-artifact.v1' || !Array.isArray(manifest.files) ||
          !manifest.files.length || manifest.files.some(row => typeof row?.path !== 'string' ||
            row.path.startsWith('/') || row.path.split('/').some(part => !part || part === '.' || part === '..')) ||
          !['css/', 'js/'].every(prefix => manifest.files.some(row => row.path.startsWith(prefix))))
        throw new Error('Static manifest unavailable');
      const files = new Set(manifest.files.map(row => row.path));
      for (const row of manifest.files) if (/^(js|css)\/.*\.(?:m?js|css)$/.test(row.path) &&
          /^[a-f0-9]{64}$/.test(row.sha256 || '') && Number.isSafeInteger(row.bytes) && row.bytes >= 0)
        builtStaticFiles.set('/' + row.path, { bytes: row.bytes, sha256: row.sha256 });
      const paths = new Set([...files].filter(path => /^(css|data|js|public-shell|tours)\//.test(path)).map(path => '/' + path));
      for (const [route, asset] of [
        ['/manifest.webmanifest', 'manifest.webmanifest'], ['/sw.js', 'public-shell/sw.js'],
        ['/offline.html', 'public-shell/offline.html'], ['/favicon.ico', 'public-shell/icons/dealroom.svg'],
        ['/share.css', 'reports/share.css'], ['/share.js', 'reports/share.js'], ['/share-bootstrap.js', 'reports/share-bootstrap.js'],
      ]) if (files.has(asset)) paths.add(route);
      for (const asset of files) {
        if (asset.startsWith('public-shell/icons/')) paths.add('/icons/' + asset.slice('public-shell/icons/'.length));
        if (asset.startsWith('reports/vendor/')) paths.add('/vendor/' + asset.slice('reports/vendor/'.length));
      }
      return paths;
    }).catch(() => policyFailure('browser-inventory-unavailable'));
  return builtStaticPaths;
}

async function knownBrowserRead(url) {
  const paths = await assertStagingBrowserInventory();
  if (browserPages.has(url.pathname) || httpReads.has(url.pathname) ||
      /^\/control-room\/progress\/board\/[^/%]+$/.test(url.pathname) ||
      /^\/api\/v1\/business\/(clients|vendors)\/[0-9a-f-]{36}$/i.test(url.pathname) ||
      /^\/api\/system-work\/WR-\d+$/.test(url.pathname)) return true;
  return paths.has(url.pathname);
}

const fixtureWrites = {
  'set-next-step': { record: 'deal', field: 'deal', keys: ['deal', 'text', 'next_date', 'idempotency_key'], values: ['text', 'next_date'] },
  'add-deal-note': { record: 'deal', field: 'deal', keys: ['deal', 'text', 'idempotency_key'], values: ['text'] },
  'rename-doc-conversation': { record: 'conversation', field: 'conversation_id',
    keys: ['conversation_id', 'base_version', 'title', 'pinned', 'archived', 'idempotency_key'], values: ['title', 'pinned', 'archived'] },
  'claim-lead': { record: 'lead', field: 'lead', keys: ['lead', 'base_version', 'expected_actor', 'idempotency_key'], values: [] },
  'update-lead': { record: 'lead', field: 'lead',
    keys: ['lead', 'base_version', 'expected_actor', 'fields', 'stage_review', 'idempotency_key'], values: ['fields'] },
  'link-lead-client': { record: 'lead', field: 'lead',
    keys: ['lead', 'base_version', 'expected_actor', 'client_id', 'confirmed', 'idempotency_key'], values: ['client_id'] },
  'patch-deal-field': { record: 'deal', field: 'deal',
    keys: ['deal', 'field', 'value', 'base_event_id', 'change_reason', 'human_quote', 'idempotency_key'], values: ['field', 'value'] },
  'revert-deal-field': { record: 'deal', field: 'deal',
    keys: ['event_id', 'idempotency_key'], values: ['event_id'] },
  'add-critical-date': { record: 'deal', field: 'deal',
    keys: ['deal', 'kind', 'due_on', 'source', 'note', 'idempotency_key'], values: ['kind', 'due_on', 'source', 'note'] },
};
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const policyFailure = code => { throw Object.assign(new Error('Staging fixture write refused: ' + code), { code, fixturePolicy: true }); };

// Match the pinned producer's actual response shapes. A transport success is
// not a receipt. update-lead returns only updated column names: it cannot bind
// the target/value and therefore remains unresolved until separate reconciliation.
function completeOperationReceipt(name, args, recordIDs, receipt, attemptedAt, plan) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.ok !== true || receipt.error)
    return null;
  const primary = recordIDs[0];
  const timestamp = value => typeof value === 'string' && typeof attemptedAt === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) >= Date.parse(attemptedAt) - 5000 && Date.parse(value) <= Date.now() + 5000;
  const keys = allowed => Object.keys(receipt).every(key => ['ok', 'replayed', ...allowed].includes(key)) &&
    (receipt.replayed === undefined || receipt.replayed === false);
  let effect;
  if (name === 'set-next-step' && keys(['deal_id', 'next_step_id', 'next_action_id', 'supersedes', 'created_at']) &&
      receipt.deal_id === primary && isUUID(receipt.next_step_id || '') && isUUID(receipt.next_action_id || '') &&
      new Set([primary, receipt.next_step_id, receipt.next_action_id]).size === 3 && (receipt.supersedes === null || isUUID(receipt.supersedes || '')) &&
      timestamp(receipt.created_at)) effect = { next_step_id: receipt.next_step_id, next_action_id: receipt.next_action_id, created_at: receipt.created_at };
  if (name === 'add-deal-note' && keys(['deal_id', 'note_id', 'created_at']) &&
      receipt.deal_id === primary && isUUID(receipt.note_id || '') && receipt.note_id !== primary && timestamp(receipt.created_at))
    effect = { note_id: receipt.note_id, created_at: receipt.created_at };
  if (name === 'rename-doc-conversation' && keys(['conversation_id', 'version', 'title', 'pinned', 'archived']) &&
      receipt.conversation_id === primary && receipt.version === args.base_version + 1 &&
      typeof receipt.title === 'string' && receipt.title.trim() && typeof receipt.pinned === 'boolean' && typeof receipt.archived === 'boolean' &&
      ['title', 'pinned', 'archived'].every(key => args[key] === undefined || receipt[key] === args[key]))
    effect = { version: receipt.version, title: receipt.title, pinned: receipt.pinned, archived: receipt.archived };
  if (name === 'claim-lead' && keys(['lead_id', 'owner']) && receipt.lead_id === primary && receipt.owner === args.expected_actor)
    effect = { owner: receipt.owner };
  if (name === 'link-lead-client' && keys(['lead_id', 'client_id']) &&
      receipt.lead_id === primary && receipt.client_id === args.client_id && recordIDs.includes(receipt.client_id))
    effect = { client_id: receipt.client_id };
  if (name === 'patch-deal-field' && keys(['deal_id', 'field', 'old_value', 'new_value', 'event_id', 'event_recorded_at']) &&
      receipt.deal_id === primary && receipt.field === 'phase' && args.field === 'phase' &&
      stagingPhaseSlugs.has(receipt.old_value) && stagingPhaseSlugs.has(receipt.new_value) &&
      receipt.new_value === args.value && isUUID(receipt.event_id || '') &&
      timestamp(receipt.event_recorded_at))
    effect = { field: 'phase', old_value: receipt.old_value, new_value: receipt.new_value,
      event_id: receipt.event_id, event_recorded_at: receipt.event_recorded_at };
  if (name === 'revert-deal-field' && keys(['deal_id', 'field', 'reverted_event_id', 'old_value', 'new_value', 'event_id', 'event_recorded_at']) &&
      receipt.deal_id === primary && receipt.field === 'phase' && receipt.reverted_event_id === args.event_id &&
      stagingPhaseSlugs.has(receipt.old_value) && stagingPhaseSlugs.has(receipt.new_value) &&
      isUUID(receipt.event_id || '') && receipt.event_id !== receipt.reverted_event_id &&
      timestamp(receipt.event_recorded_at)) {
    const prior = plan?.browser_write_attempts?.find(row => row.operation === 'patch-deal-field' &&
      row.state === 'acknowledged' && row.record_ids?.includes(primary) &&
      row.response?.receipt?.event_id === args.event_id);
    const priorBinding = prior && completeOperationReceipt('patch-deal-field', prior.arguments, prior.record_ids,
      prior.response?.receipt, prior.attempted_at);
    if (prior && priorBinding && prior.response?.binding && digest(priorBinding) === digest(prior.response.binding) &&
        priorBinding.effect.new_value === receipt.old_value && priorBinding.effect.old_value === receipt.new_value)
      effect = { field: 'phase', reverted_event_id: receipt.reverted_event_id,
        prior_old_value: priorBinding.effect.old_value,
        old_value: receipt.old_value, new_value: receipt.new_value,
        event_id: receipt.event_id, event_recorded_at: receipt.event_recorded_at };
  }
  if (name === 'add-critical-date' && keys(['critical_date_id']) &&
      isUUID(receipt.critical_date_id || '') && receipt.critical_date_id !== primary &&
      args.kind === 'rent_start' && typeof args.due_on === 'string' &&
      isCalendarDate(args.due_on) && textWithin(args.source, 4000) &&
      (args.note === undefined || textWithin(args.note, 4000)))
    effect = { critical_date_id: receipt.critical_date_id, kind: args.kind,
      due_on: args.due_on, source: args.source, note: args.note ?? null };
  return effect ? { operation: name, record_ids: recordIDs, arguments_sha256: digest(args), effect } : null;
}

const textWithin = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const stagingPhaseSlugs = new Set(COLUMNS.map(column => column.slug));
const fixtureWritesNeedingReadback = new Set(['patch-deal-field', 'revert-deal-field', 'add-critical-date']);
function journeyObservation(row) {
  const effect = row.response?.binding?.effect;
  if (!effect) return null;
  if (row.operation === 'patch-deal-field') return { phase: effect.new_value, event_id: effect.event_id };
  if (row.operation === 'revert-deal-field')
    return { phase: effect.new_value, reverted_event_id: effect.reverted_event_id, badge: 'Undone' };
  if (row.operation === 'add-critical-date')
    return { critical_date_id: effect.critical_date_id, due_on: effect.due_on, source: effect.source };
  return null;
}
function observedJourneyUI(row) {
  const ui = row.journey?.ui;
  return row.journey?.state === 'observed' && ui?.schema === 'staging-business-journey-ui.v1' &&
    ui.observation_sha256 === digest(journeyObservation(row)) &&
    Number.isFinite(Date.parse(ui.observed_at)) && Date.parse(ui.observed_at) >= Date.parse(row.journey.admitted_at) &&
    Date.parse(ui.observed_at) <= Date.now() + 5000;
}
function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function hasPhaseEvent(detail, eventId, oldValue, newValue, verb) {
  return Array.isArray(detail?.events) && detail.events.some(event => event?.id === eventId &&
    event.subject_id === detail.deal_id && event.subject_type === 'deal' && event.field === 'phase' &&
    event.verb === verb && event.old_value?.phase === oldValue && event.new_value?.phase === newValue);
}

function verifiedReadback(row, detail, plan) {
  const binding = row.response?.binding;
  const effect = binding?.effect;
  if (binding?.operation === 'patch-deal-field') {
    const eventProved = hasPhaseEvent(detail, effect.event_id, effect.old_value, effect.new_value, 'patch-deal-field');
    if (detail?.deal_id !== row.record_ids[0] || !eventProved) return false;
    if (detail.phase === effect.new_value) return true;
    const undo = plan.browser_write_attempts?.find(attempt => attempt.operation === 'revert-deal-field' &&
      attempt.state === 'acknowledged' && attempt.arguments?.event_id === effect.event_id);
    const undoEffect = undo?.response?.binding?.effect;
    return Boolean(undoEffect && detail.phase === undoEffect.new_value &&
      undoEffect.reverted_event_id === effect.event_id &&
      hasPhaseEvent(detail, undoEffect.event_id, undoEffect.old_value, undoEffect.new_value, 'revert-deal-field'));
  }
  if (binding?.operation === 'revert-deal-field')
    return detail?.deal_id === row.record_ids[0] && detail.phase === effect.new_value &&
      hasPhaseEvent(detail, effect.event_id, effect.old_value, effect.new_value, 'revert-deal-field') &&
      Array.isArray(detail.events) && detail.events.some(event => event?.id === effect.reverted_event_id &&
        event.subject_id === detail.deal_id && event.field === 'phase' && event.verb === 'patch-deal-field' &&
        event.old_value?.phase === effect.prior_old_value && event.new_value?.phase === effect.old_value);
  if (binding?.operation === 'add-critical-date')
    return detail?.deal_id === row.record_ids[0] && Array.isArray(detail.critical_dates) &&
      detail.critical_dates.some(date => date?.id === effect.critical_date_id && date.deal_id === detail.deal_id &&
        date.kind === effect.kind && date.due_on === effect.due_on && date.source === effect.source &&
        date.note === effect.note);
  return true;
}

function requirePlanCoverage(plan, scope) {
  if (!plan || plan.schema !== 'doctorcre-staging-records-plan.v1' || plan.origin !== STAGING_ORIGIN ||
      plan.state !== 'complete' || plan.inflight) policyFailure('fixture-provenance-missing');
  const attempts = scope ? (plan.browser_write_attempts ?? []).filter(row => scope.fingerprints.has(row.fingerprint) || row.journey) : plan.browser_write_attempts ?? [];
  const refusals = scope ? scope.refusals : plan.browser_write_refusals ?? [];
  if (!Array.isArray(attempts) || !Array.isArray(refusals) || refusals.length ||
      attempts.some(row => {
        if (row.state !== 'acknowledged' || row.response?.acknowledged !== true ||
            !Array.isArray(row.record_ids) || !row.record_ids.length || !row.record_ids.every(isUUID)) return true;
        const bound = completeOperationReceipt(row.operation, row.arguments, row.record_ids, row.response.receipt, row.attempted_at, plan);
        const needsReadback = fixtureWritesNeedingReadback.has(row.operation);
        return !bound || !row.response.binding || digest(bound) !== digest(row.response.binding) ||
          needsReadback && !validIndependentReadback(row) || row.journey && !observedJourneyUI(row);
      })) policyFailure('write-coverage-incomplete');
}

function validIndependentReadback(row) {
  return row.independent_readback?.schema === 'staging-fixture-business-readback.v1' &&
    row.independent_readback.operation === 'get-deal-room' &&
    row.independent_readback.record_id === row.record_ids?.[0] &&
    row.independent_readback.matched === true && /^[a-f0-9]{64}$/.test(row.independent_readback.response_sha256 || '') &&
    typeof row.independent_readback.observed_at === 'string' && Number.isFinite(Date.parse(row.independent_readback.observed_at));
}

// One test-harness seam, using the existing private setup/receipt store.
// Unsupported global/account/runtime operations remain explicit coverage gaps.
export function stagingFixtureWriteGuard({ output, release, run = process.env.E2E_RUN_SUPERVISED === '1' ? requireSupervisedRun(output) : undefined, persist = (path, value) => privateJSON(path, value, false, run) } = {}) {
  const planPath = typeof output === 'string' ? join(output, 'staging-records-plan.json') : null;
  const refusals = [], pending = new Set();
  const staticCache = new Map();
  const cacheCeiling = Math.min(effectiveRunLimits(run).artifactBytes, 8 * 1024 * 1024);
  let cachedBytes = 0;
  run?.onStop(() => { staticCache.clear(); cachedBytes = 0; });
  let serial = Promise.resolve();
  const locked = work => {
    const next = serial.then(work);
    serial = next.catch(() => {});
    return next;
  };
  const currentPlan = async () => {
    if (!planPath) policyFailure('fixture-provenance-missing');
    const plan = await readPrivateJSON(planPath);
    if (!plan || plan.schema !== 'doctorcre-staging-records-plan.v1' ||
        plan.state !== 'complete' || plan.inflight || plan.origin !== STAGING_ORIGIN ||
        !isUUID(plan.run || '') || plan.release?.source_commit !== release?.source_commit ||
        plan.release?.carr_source_commit !== release?.carr_source_commit ||
        release?.carr_source_commit !== contract.producer.source_commit ||
        !/^[0-9a-f]{40}$/.test(release?.source_commit || '') || !plan.records || !plan.receipts)
      policyFailure('fixture-provenance-missing');
    return plan;
  };
  const owned = (plan, record, reference) => {
    const row = plan.records[record], step = record === 'invoice' ? 'invoice_deal' : record;
    const field = { deal: 'deal_id', invoice: 'deal_id', client: 'client_id', lead: 'lead_id', conversation: 'conversation_id' }[record];
    const id = row?.id || row?.deal_id;
    return field && isUUID(id || '') && plan.receipts[step]?.[field] === id &&
      (reference === id || record === 'lead' && row.ref && reference === row.ref) ? id : null;
  };
  const proveOperation = (plan, name, args) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) policyFailure('operation-shape-unproved');
    if (browserReads.has(name)) return null;
    const spec = Object.hasOwn(fixtureWrites, name) ? fixtureWrites[name] : null;
    if (!spec || Object.keys(args).some(key => !spec.keys.includes(key)) ||
        !isUUID(args.idempotency_key || '')) policyFailure('operation-scope-unproved');
    const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4000;
    const version = Number.isSafeInteger(args.base_version) && args.base_version > 0;
    if (['set-next-step', 'add-deal-note'].includes(name) && !text(args.text) ||
        name === 'set-next-step' && args.next_date != null && (typeof args.next_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.next_date)) ||
        name === 'rename-doc-conversation' && (!version ||
          !['title', 'pinned', 'archived'].some(key => Object.hasOwn(args, key)) ||
          args.title !== undefined && !text(args.title) ||
          ['pinned', 'archived'].some(key => args[key] !== undefined && typeof args[key] !== 'boolean')) ||
        spec.record === 'lead' && (!version || args.expected_actor !== 'joe') ||
        name === 'link-lead-client' && args.confirmed !== true)
      policyFailure('operation-shape-unproved');
    if (name === 'update-lead') {
      const review = args.stage_review;
      if (!args.fields || Array.isArray(args.fields) || Object.keys(args.fields).length !== 1 ||
          !text(args.fields.stage) || !review || Array.isArray(review) ||
          Object.keys(review).some(key => !['reason', 'evidence_ids', 'human_quote'].includes(key)) ||
          !text(review.reason) || !Array.isArray(review.evidence_ids) || review.evidence_ids.length ||
          review.human_quote !== undefined && !text(review.human_quote))
        policyFailure('operation-shape-unproved');
    }
    const attempts = plan.browser_write_attempts || [];
    if (name === 'patch-deal-field') {
      const phases = new Set(COLUMNS.map(column => column.slug));
      const knownPhaseEvent = args.base_event_id === null || attempts.some(row =>
        ['patch-deal-field', 'revert-deal-field'].includes(row.operation) && row.state === 'acknowledged' &&
        row.record_ids?.includes(args.deal) && row.response?.receipt?.event_id === args.base_event_id);
      if (args.field !== 'phase' || !phases.has(args.value) || ['pending', 'closed'].includes(args.value) ||
          !Object.hasOwn(args, 'base_event_id') || !knownPhaseEvent ||
          args.change_reason !== undefined && !text(args.change_reason) ||
          args.human_quote !== undefined && !text(args.human_quote) ||
          attempts.some(row => row.operation === name && row.record_ids?.includes(args.deal)))
        policyFailure('operation-shape-unproved');
    }
    let priorPhasePatch = null;
    if (name === 'revert-deal-field') {
      const prior = attempts.find(row => row.operation === 'patch-deal-field' && row.state === 'acknowledged' &&
        row.response?.receipt?.event_id === args.event_id);
      const priorBinding = prior && completeOperationReceipt('patch-deal-field', prior.arguments,
        prior.record_ids, prior.response?.receipt, prior.attempted_at, plan);
      if (!priorBinding || !prior.response?.binding || digest(priorBinding) !== digest(prior.response.binding) ||
          attempts.some(row => row.operation === name && row.arguments?.event_id === args.event_id))
        policyFailure('operation-shape-unproved');
      priorPhasePatch = prior;
    }
    if (name === 'add-critical-date' && (args.kind !== 'rent_start' || !isCalendarDate(args.due_on) ||
        !text(args.source) || args.note !== undefined && !text(args.note) ||
        attempts.some(row => row.operation === name && row.record_ids?.includes(args.deal))))
      policyFailure('operation-shape-unproved');
    const id = ['patch-deal-field', 'add-critical-date'].includes(name)
      ? owned(plan, 'deal', args.deal)
      : name === 'revert-deal-field' && priorPhasePatch
        ? owned(plan, 'deal', priorPhasePatch.arguments?.deal)
        : owned(plan, spec.record, args[spec.field]) ||
          spec.record === 'deal' && owned(plan, 'invoice', args[spec.field]);
    if (!id) policyFailure('record-outside-fixtures');
    const ids = new Set([id]);
    if (name === 'link-lead-client') {
      const client = owned(plan, 'client', args.client_id);
      if (!client) policyFailure('reference-outside-fixtures');
      ids.add(client);
    }
    // No nested additional record references may ride through review
    // metadata. Text values are ordinary content, not inferred identity.
    const referenceArguments = { ...args };
    if (name === 'patch-deal-field') delete referenceArguments.base_event_id;
    if (name === 'revert-deal-field') delete referenceArguments.event_id;
    const referencesOwned = value => Object.entries(value || {}).every(([key, val]) =>
      val && typeof val === 'object' ? referencesOwned(val) :
        key === 'id' || key.endsWith('_id') ? ids.has(val) : true);
    if (!referencesOwned(referenceArguments)) policyFailure('reference-outside-fixtures');
    const fingerprintValues = Object.fromEntries(spec.values.map(key => [key,
      ['add-deal-note', 'set-next-step'].includes(name) && key === 'text' && typeof args[key] === 'string'
        ? args[key].trim() : args[key] ?? null]));
    const fingerprint = digest([name, id, fingerprintValues]);
    if (Object.values(plan.keys || {}).includes(args.idempotency_key) ||
        attempts.some(row => row.fingerprint === fingerprint || row.arguments?.idempotency_key === args.idempotency_key))
      policyFailure('duplicate-attempt-requires-reconciliation');
    if (attempts.some(row => ['inflight', 'unresolved'].includes(row.state) &&
        row.record_ids.some(record => ids.has(record))))
      policyFailure('ambiguous-record-requires-reconciliation');
    const pendingReadback = attempts.find(row => row.state === 'acknowledged' && row.record_ids?.some(record => ids.has(record)) &&
      fixtureWritesNeedingReadback.has(row.operation) && !validIndependentReadback(row));
    const pairedUndo = name === 'revert-deal-field' && pendingReadback?.operation === 'patch-deal-field' &&
      pendingReadback.response?.receipt?.event_id === args.event_id;
    if (pendingReadback && !pairedUndo) policyFailure('ambiguous-record-requires-reconciliation');
    return { ids, fingerprint };
  };
  const reconcileDealRoomRead = async (response, requestedDeal, requestId) => {
    if (typeof requestedDeal !== 'string' || !isUUID(requestedDeal) || !planPath) return;
    let rpc, detail;
    try {
      rpc = await response.json();
      detail = JSON.parse(rpc?.result?.content?.[0]?.text || 'null');
    } catch { return; }
    if (response.status() !== 200 || rpc?.jsonrpc !== '2.0' || rpc.id !== requestId || rpc.error || rpc.result?.isError ||
        !Array.isArray(rpc.result?.content) || rpc.result.content.length !== 1 ||
        rpc.result.content[0]?.type !== 'text' || detail?.deal_id !== requestedDeal) return;
    const responseHash = digest(rpc);
    await locked(async () => {
      const plan = await currentPlan();
      let changed = false;
      for (const row of plan.browser_write_attempts || []) {
        if (row.state !== 'acknowledged' || !row.record_ids?.includes(requestedDeal) ||
            !['patch-deal-field', 'revert-deal-field', 'add-critical-date'].includes(row.operation) ||
            validIndependentReadback(row) || !verifiedReadback(row, detail, plan)) continue;
        row.independent_readback = {
          schema: 'staging-fixture-business-readback.v1', operation: 'get-deal-room',
          record_id: requestedDeal, response_sha256: responseHash, matched: true,
          observed_at: new Date().toISOString(),
        };
        changed = true;
      }
      if (changed) await persist(planPath, plan);
    });
  };
  const retainRefusal = async (gap, scope) => {
    refusals.push(gap);
    scope?.refusals.push(gap);
    try {
      await locked(async () => {
        const plan = planPath ? await readPrivateJSON(planPath) : null;
        if (plan?.schema === 'doctorcre-staging-records-plan.v1' && plan.state === 'complete') {
          plan.browser_write_refusals ||= []; plan.browser_write_refusals.push(gap);
          await persist(planPath, plan);
        }
      });
    } catch {}
  };
  const guard = {
    refusals,
    forContext() {
      const scope = { refusals: [], pending: new Set(), fingerprints: new Set() };
      return {
        refusals: scope.refusals,
        handle: (request, forward) => guard.handle(request, forward, scope),
        assertCoverage: options => guard.assertCoverage(options, scope),
        admitControl: control => guard.admitControl(control, scope),
        admitBusinessJourneyStep: step => guard.admitBusinessJourneyStep(step),
      };
    },
    async admitBusinessJourneyStep(spec) {
      requireSupervisedRun(output, run);
      run.check();
      if (!spec || Object.keys(spec).some(key => !['phase', 'journey', 'step', 'deal', 'release', 'observation'].includes(key)) ||
          !['admit', 'status', 'observe'].includes(spec.phase) ||
          businessJourneys.schema !== 'doctorcre-e2e-staging-business-journeys.v1' ||
          businessJourneys.full_v1_qualification !== false ||
          businessJourneys.producer.source_commit !== contract.producer.source_commit)
        policyFailure('journey-scope-unproved');
      const journey = businessJourneys.journeys.find(journey => journey.id === spec.journey);
      const definition = journey?.steps.find(step => step.id === spec.step);
      if (!definition) policyFailure('journey-scope-unproved');
      for (const [path, hash] of Object.entries(businessJourneys.sources)) {
        const bytes = await readFile(new URL('../../' + path, import.meta.url));
        if (createHash('sha256').update(bytes).digest('hex') !== hash) policyFailure('journey-source-changed');
      }
      return locked(async () => {
        const plan = await currentPlan();
        if (spec.release?.source_commit !== plan.release.source_commit ||
            spec.release?.carr_source_commit !== plan.release.carr_source_commit)
          policyFailure('journey-source-pair-changed');
        if (!owned(plan, 'deal', spec.deal)) policyFailure('record-outside-fixtures');
        const attempts = plan.browser_write_attempts || [];
        const previous = attempts.find(row => row.journey?.id === spec.journey && row.journey?.step === definition.predecessor);
        let template;
        if (definition.operation === 'patch-deal-field')
          template = { deal: spec.deal, field: 'phase', value: definition.value, base_event_id: null };
        if (definition.operation === 'revert-deal-field') {
          if (!observedJourneyUI(previous || {}) || !validIndependentReadback(previous) ||
              previous.response?.binding?.effect?.old_value !== journey.steps.find(step => step.id === definition.predecessor)?.initial_phase)
            policyFailure('journey-predecessor-unproved');
          template = { event_id: previous.response.binding.effect.event_id };
        }
        if (definition.operation === 'add-critical-date')
          template = { deal: spec.deal, kind: definition.kind, due_on: definition.due_on,
            source: definition.source_prefix + plan.run };
        if (!template) policyFailure('journey-scope-unproved');
        const matches = attempts.filter(row => row.journey?.id === spec.journey && row.journey?.step === spec.step);
        if (matches.length > 1) policyFailure('journey-step-requires-reconciliation');
        let row = matches[0];
        if (row && (row.journey.schema !== 'staging-business-journey-step.v1' ||
            row.journey.contract_sha256 !== digest(businessJourneys) || row.journey.fixture_run !== plan.run ||
            digest(row.journey.release) !== digest(plan.release) || digest(row.argument_template) !== digest(template) ||
            row.operation !== definition.operation || row.record_ids?.length !== 1 || row.record_ids[0] !== spec.deal))
          policyFailure('journey-binding-changed');
        if (spec.phase === 'status') {
          if (!row) policyFailure('journey-intent-missing');
          return structuredClone(row);
        }
        if (spec.phase === 'admit') {
          if (row) {
            if (!observedJourneyUI(row)) policyFailure('journey-step-requires-reconciliation');
            requirePlanCoverage(plan);
            return structuredClone(row);
          }
          requirePlanCoverage(plan);
          const { ids, fingerprint } = proveOperation(plan, definition.operation, { ...template, idempotency_key: randomUUID() });
          row = { schema: 'staging-fixture-browser-intent.v1', fingerprint, operation: definition.operation,
            record_ids: [...ids], argument_template: template, arguments: structuredClone(template), state: 'admitted',
            dispatched_outcome: 'not dispatched', journey: { schema: 'staging-business-journey-step.v1',
              id: spec.journey, step: spec.step, fixture_run: plan.run, contract_sha256: digest(businessJourneys),
              release: structuredClone(plan.release), admitted_at: new Date().toISOString(), state: 'admitted' } };
          plan.browser_write_attempts ||= [];
          plan.browser_write_attempts.push(row);
          await persist(planPath, plan);
          return structuredClone(row);
        }
        if (!row || row.journey.state !== 'admitted') policyFailure('journey-observation-unproved');
        const effect = row.response?.binding?.effect;
        if (!effect || definition.operation === 'patch-deal-field' && effect.old_value !== definition.initial_phase ||
            digest(spec.observation) !== digest(journeyObservation(row))) policyFailure('journey-observation-unproved');
        row.journey.state = 'observed';
        row.journey.ui = { schema: 'staging-business-journey-ui.v1', observation_sha256: digest(spec.observation),
          observed_at: new Date().toISOString() };
        requirePlanCoverage(plan);
        await persist(planPath, plan);
        return structuredClone(row);
      });
    },
    async admitControl(control, scope) {
      await guard.assertCoverage({}, scope);
      // No effects are inferred from a selector, name, or app-provided attribute.
      // Only an exact reviewed action in this source-pair-bound private plan is
      // eligible. An empty effects list declares a reviewed local-only action.
      const plan = await currentPlan();
      try {
        if (!control || typeof control.identity !== 'string' || !control.identity) policyFailure('control-scope-unproved');
        if (control.disabled === true) return;
        const proofs = plan.browser_control_proofs;
        const matches = Array.isArray(proofs) ? proofs.filter(proof => proof?.identity === control.identity) : [];
        if (matches.length !== 1 || !Array.isArray(matches[0].effects) ||
            matches[0].release?.source_commit !== plan.release.source_commit ||
            matches[0].release?.carr_source_commit !== plan.release.carr_source_commit) policyFailure('control-scope-unproved');
        for (const effect of matches[0].effects) {
          if (!effect || typeof effect !== 'object' || Array.isArray(effect) ||
              Object.keys(effect).some(key => !['operation', 'arguments'].includes(key)))
            policyFailure('control-scope-unproved');
          proveOperation(plan, effect.operation, effect.arguments);
        }
        if (!validControlProof(matches[0])) policyFailure('control-scope-unproved');
        return { observations: structuredClone(matches[0].observations) };
      } catch (error) {
        if (!error.fixturePolicy) throw error;
        const skipped = { identity: control?.identity || null, reason: error.code,
          press_attempted: false, handler_executions: 0, at: new Date().toISOString() };
        await locked(async () => {
          const latest = await currentPlan();
          latest.browser_control_skips ||= [];
          latest.browser_control_skips.push(skipped);
          await persist(planPath, latest);
        });
        throw Object.assign(new Error('Reviewed control proof unavailable: ' + error.code),
          { controlProofUnavailable: true, code: error.code });
      }
    },
    async assertCoverage({ timeoutMs = effectiveRunLimits(run).settlementMs } = {}, scope) {
      const outstanding = scope?.pending || pending, gaps = scope?.refusals || refusals;
      const budget = Math.min(effectiveRunLimits(run).settlementMs, Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : effectiveRunLimits(run).settlementMs));
      const deadline = Date.now() + budget;
      while (outstanding.size) {
        let timer;
        const expired = new Promise(resolve => { timer = setTimeout(() => resolve(true), Math.max(0, deadline - Date.now())); });
        let timedOut;
        try { timedOut = await Promise.race([Promise.all([...outstanding].map(flight => flight.done)).then(() => false), expired]); }
        finally { clearTimeout(timer); }
        if (timedOut) {
          for (const flight of outstanding) flight.timedOut = true;
          const gap = { operation: 'unknown-operation', reason: 'dispatch-settlement-timeout', forwarded: true, at: new Date().toISOString() };
          refusals.push(gap);
          if (scope) scope.refusals.push(gap);
          policyFailure('dispatch-settlement-timeout');
        }
      }
      if (gaps.length) policyFailure('write-coverage-incomplete');
      if (planPath) requirePlanCoverage(await currentPlan(), scope);
      if (outstanding.size) policyFailure('dispatch-settlement-pending');
    },
    async handle(request, forward, scope) {
      const flight = { timedOut: false };
      flight.done = new Promise(resolve => { flight.finish = resolve; });
      run?.check();
      pending.add(flight);
      scope?.pending.add(flight);
      const dispatch = () => {
        if (!run) throw new RunLimitError('supervised-run-required');
        requireSupervisedRun(output, run);
        return run.http(forward);
      };
      let name = 'unknown-operation', token, dispatched = false, admittedRead = false, localCompanionRead = false;
      const forwardRead = async (staticURL) => {
        admittedRead = true;
        const asset = staticURL && request.method() === 'GET' && !staticURL.search && !staticURL.hash
          ? builtStaticFiles.get(staticURL.pathname) : null;
        const cacheKey = asset && JSON.stringify([release?.source_commit, release?.carr_source_commit, staticURL.pathname]);
        const cached = cacheKey && staticCache.get(cacheKey);
        if (cached) {
          requireSupervisedRun(output, run);
          return { cachedRead: true, status: () => 200, headers: () => ({ ...cached.headers }), body: async () => Buffer.from(cached.body) };
        }
        const response = await dispatch();
        if (flight.timedOut) policyFailure('dispatch-settlement-timeout');
        // Never give the browser a redirect to follow outside interception.
        // Known aliases also remain coverage gaps until directly addressed.
        if (response.status() >= 300 && response.status() < 400 && response.status() !== 304)
          policyFailure('read-redirect-unproved');
        if (asset && response.status() === 200 && typeof response.headers === 'function' && typeof response.body === 'function' &&
            asset.bytes <= cacheCeiling - cachedBytes) {
          const headers = response.headers();
          if (!Object.keys(headers).some(key => key.toLowerCase() === 'set-cookie')) {
            const body = await response.body();
            run.check();
            // Replay only exact built bytes fetched under this source pair.
            // Documents, APIs, fonts, query variants and mismatches stay live.
            if (body.length === asset.bytes && createHash('sha256').update(body).digest('hex') === asset.sha256 &&
                !staticCache.has(cacheKey) && body.length <= cacheCeiling - cachedBytes) {
              const decodedHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) =>
                !['content-encoding', 'content-length'].includes(key.toLowerCase())));
              staticCache.set(cacheKey, { headers: decodedHeaders, body: Buffer.from(body) });
              cachedBytes += body.length;
            }
          }
        }
        return response;
      };
      try {
        const url = new URL(request.url());
        if (url.username || url.password) policyFailure('origin-unproved');
        const read = ['GET', 'HEAD'].includes(request.method());
        if (url.origin !== STAGING_ORIGIN) {
          // The app probes its optional local companion on every boot. Refuse
          // this exact read without treating companion absence as a staging write.
          if (request.method() === 'GET' && url.href === 'http://127.0.0.1:4682/api/state') {
            localCompanionRead = true;
            throw Object.assign(new Error('Local companion read blocked'), { code: 'local-companion-read-blocked' });
          }
          const font = read && (url.origin === 'https://fonts.googleapis.com' && ['/css', '/css2'].includes(url.pathname) ||
            url.origin === 'https://fonts.gstatic.com' && /^\/s\/[a-zA-Z0-9/_-]+\.(woff2?|ttf)$/.test(url.pathname));
          if (font) return await forwardRead();
          policyFailure('origin-unproved');
        }
        if (['GET', 'HEAD'].includes(request.method())) {
          // Login/callback/reauth establish or change session state even on GET.
          // The preflight session read is the only admitted authentication route.
          if (url.pathname.startsWith('/auth/') && url.pathname !== stagingAuth.session.path)
            policyFailure('authentication-mutation-unproved');
          if (!await knownBrowserRead(url)) policyFailure('read-path-unproved');
          return await forwardRead(url);
        }
        let body;
        try { body = request.postDataJSON(); } catch {}
        if (request.method() !== 'POST' || url.pathname !== '/mcp' || url.search || url.hash ||
            body?.jsonrpc !== '2.0' || body.method !== 'tools/call')
          policyFailure('operation-scope-unproved');
        name = body.params?.name;
        const args = body.params?.arguments;
        if (!args || typeof args !== 'object' || Array.isArray(args)) policyFailure('operation-shape-unproved');
        if (browserReads.has(name)) {
          const response = await forwardRead();
          if (name === 'get-deal-room') await reconcileDealRoomRead(response, args.deal, body.id);
          return response;
        }
        if (!(typeof body.id === 'string' && body.id || Number.isSafeInteger(body.id)))
          policyFailure('operation-shape-unproved');
        token = await locked(async () => {
          const plan = await currentPlan();
          const admitted = (plan.browser_write_attempts || []).filter(row => row.state === 'admitted' && row.journey);
          const intent = admitted.length === 1 ? admitted[0] : null;
          if ((plan.browser_write_attempts || []).some(row => row.journey) && !intent)
            policyFailure('journey-intent-missing');
          const actualTemplate = { ...args };
          delete actualTemplate.idempotency_key;
          if (admitted.length && (!intent || intent.operation !== name ||
              digest(actualTemplate) !== digest(intent.argument_template))) policyFailure('journey-request-unproved');
          if (intent && (intent.journey.schema !== 'staging-business-journey-step.v1' || intent.journey.state !== 'admitted' ||
              intent.journey.fixture_run !== plan.run ||
              digest(intent.journey.release) !== digest(plan.release) ||
              intent.journey.contract_sha256 !== digest(businessJourneys))) policyFailure('journey-binding-changed');
          const { ids, fingerprint } = proveOperation(intent ? { ...plan,
            browser_write_attempts: plan.browser_write_attempts.filter(row => row !== intent) } : plan, name, args);
          plan.browser_write_attempts ||= [];
          const dispatchedIntent = { schema: 'staging-fixture-browser-intent.v1', fingerprint,
            operation: name, record_ids: [...ids], arguments: structuredClone(args),
            state: 'inflight', dispatched_outcome: 'unknown', attempted_at: new Date().toISOString() };
          if (intent) {
            if (intent.fingerprint !== fingerprint) policyFailure('journey-binding-changed');
            Object.assign(intent, dispatchedIntent);
          } else plan.browser_write_attempts.push(dispatchedIntent);
          scope?.fingerprints.add(fingerprint);
          await persist(planPath, plan); // MUST succeed before forward().
          return { run: plan.run, fingerprint };
        });
        if (flight.timedOut) policyFailure('dispatch-settlement-timeout');
        dispatched = true;
        const response = await dispatch();
        await locked(async () => {
          const plan = await currentPlan();
          if (plan.run !== token.run) policyFailure('fixture-provenance-changed');
          const intent = plan.browser_write_attempts.find(row => row.fingerprint === token.fingerprint);
          if (!intent || intent.state !== 'inflight') policyFailure('intent-binding-changed');
          let rpc;
          try { rpc = await response.json(); } catch {}
          let receipt;
          try { receipt = JSON.parse(rpc.result.content[0].text); } catch {}
          const bound = response.status() === 200 && rpc?.jsonrpc === '2.0' && rpc.id === body.id &&
            !rpc.error && !rpc.result?.isError && Array.isArray(rpc.result?.content) && rpc.result.content.length === 1 &&
            rpc.result.content[0].type === 'text'
            ? completeOperationReceipt(name, intent.arguments, intent.record_ids, receipt, intent.attempted_at, plan) : null;
          const acknowledged = Boolean(bound) && !flight.timedOut;
          intent.state = acknowledged ? 'acknowledged' : 'unresolved';
          intent.dispatched_outcome = acknowledged ? 'complete operation receipt retained; effect not independently verified' : 'unknown';
          intent.response = { http_status: response.status(), sha256: digest(rpc ?? null), acknowledged };
          if (bound) {
            intent.response.binding = bound;
            intent.response.receipt = structuredClone(receipt);
          }
          if (flight.timedOut) intent.coverage_timeout = true;
          await persist(planPath, plan);
          if (!acknowledged) policyFailure('dispatch-outcome-unresolved');
        });
        return response;
      } catch (error) {
        if (localCompanionRead) throw error;
        if (admittedRead && !error.fixturePolicy) throw error;
        const gap = { operation: typeof name === 'string' && (browserReads.has(name) || Object.hasOwn(fixtureWrites, name)) ? name : 'unknown-operation',
          reason: error.fixturePolicy ? error.code : (token ? 'dispatch-outcome-unresolved' : 'intent-or-provenance-unavailable'),
          forwarded: dispatched || admittedRead, at: new Date().toISOString() };
        // Failure to retain a refusal never permits dispatch or clears an intent.
        await retainRefusal(gap, scope);
        policyFailure(gap.reason);
      } finally { pending.delete(flight); scope?.pending.delete(flight); flight.finish(); }
    },
  };
  return guard;
}

export async function assertStagingWriteCoverage(output) {
  requirePlanCoverage(await readPrivateJSON(join(output, 'staging-records-plan.json')));
}

export async function readStagingFixtureRelease(output) {
  const setup = await readPrivateJSON(join(output, 'staging-records.json'));
  if (setup?.schema !== 'doctorcre-staging-records.v1' || setup.origin !== STAGING_ORIGIN ||
      setup.complete !== true || !/^[0-9a-f]{40}$/.test(setup.release?.source_commit || '') ||
      setup.release?.carr_source_commit !== contract.producer.source_commit)
    policyFailure('fixture-provenance-missing');
  return setup.release;
}
