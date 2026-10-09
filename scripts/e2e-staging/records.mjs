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

const browserReads = new Set(["capture-queue", "correspondence-readiness", "current-work-item", "deal-room-board", "engineering-passport", "find", "find-and-catch-up", "get-call-context", "get-deal-room", "get-incident", "governance-queue", "incident-board", "lead-board", "list-doc-conversations", "list-doc-suggestions", "list-industry-events", "list-my-codex-sessions", "list-progress-boards", "loop-board", "loop-headers", "morning-brief", "notification-feed", "read-assurance-health", "read-correspondence-thread", "read-dispatch-history", "read-doc-activity", "read-doc-conversation", "read-doc-outcome-cards", "read-invoice-tracker", "read-loop", "read-notification-preferences", "read-portfolio", "read-progress-board", "read-resource-dashboard", "read-room", "read-room-queue", "read-session-identity", "schedule-board", "today-triage", "unfinished-work", "work-request-card"]);

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
};
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const policyFailure = code => { throw Object.assign(new Error('Staging fixture write refused: ' + code), { code, fixturePolicy: true }); };

// Match the pinned producer's actual response shapes. A transport success is
// not a receipt. update-lead returns only updated column names: it cannot bind
// the target/value and therefore remains unresolved until separate reconciliation.
function completeOperationReceipt(name, args, recordIDs, receipt, attemptedAt) {
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
  return effect ? { operation: name, record_ids: recordIDs, arguments_sha256: digest(args), effect } : null;
}

function requirePlanCoverage(plan, scope) {
  if (!plan || plan.schema !== 'doctorcre-staging-records-plan.v1' || plan.origin !== STAGING_ORIGIN ||
      plan.state !== 'complete' || plan.inflight) policyFailure('fixture-provenance-missing');
  const attempts = scope ? (plan.browser_write_attempts ?? []).filter(row => scope.fingerprints.has(row.fingerprint)) : plan.browser_write_attempts ?? [];
  const refusals = scope ? scope.refusals : plan.browser_write_refusals ?? [];
  if (!Array.isArray(attempts) || !Array.isArray(refusals) || refusals.length ||
      attempts.some(row => {
        if (row.state !== 'acknowledged' || row.response?.acknowledged !== true ||
            !Array.isArray(row.record_ids) || !row.record_ids.length || !row.record_ids.every(isUUID)) return true;
        const bound = completeOperationReceipt(row.operation, row.arguments, row.record_ids, row.response.receipt, row.attempted_at);
        return !bound || !row.response.binding || digest(bound) !== digest(row.response.binding);
      })) policyFailure('write-coverage-incomplete');
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
  const guard = {
    refusals,
    forContext() {
      const scope = { refusals: [], pending: new Set(), fingerprints: new Set() };
      return {
        refusals: scope.refusals,
        handle: (request, forward) => guard.handle(request, forward, scope),
        assertCoverage: options => guard.assertCoverage(options, scope),
      };
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
        if (browserReads.has(name)) return await forwardRead();
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
        if (!(typeof body.id === 'string' && body.id || Number.isSafeInteger(body.id)))
          policyFailure('operation-shape-unproved');
        token = await locked(async () => {
          const plan = await currentPlan();
          const id = owned(plan, spec.record, args[spec.field]) ||
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
          const referencesOwned = value => Object.entries(value || {}).every(([key, val]) =>
            val && typeof val === 'object' ? referencesOwned(val) :
              key === 'id' || key.endsWith('_id') ? ids.has(val) : true);
          if (!referencesOwned(args)) policyFailure('reference-outside-fixtures');
          const fingerprintValues = Object.fromEntries(spec.values.map(key => [key,
            ['add-deal-note', 'set-next-step'].includes(name) && key === 'text' && typeof args[key] === 'string'
              ? args[key].trim() : args[key] ?? null]));
          const fingerprint = digest([name, id, fingerprintValues]);
          plan.browser_write_attempts ||= [];
          if (Object.values(plan.keys || {}).includes(args.idempotency_key) ||
              plan.browser_write_attempts.some(row => row.fingerprint === fingerprint || row.arguments?.idempotency_key === args.idempotency_key))
            policyFailure('duplicate-attempt-requires-reconciliation');
          if (plan.browser_write_attempts.some(row => ['inflight', 'unresolved'].includes(row.state) &&
              row.record_ids.some(record => ids.has(record))))
            policyFailure('ambiguous-record-requires-reconciliation');
          const intent = { schema: 'staging-fixture-browser-intent.v1', fingerprint,
            operation: name, record_ids: [...ids], arguments: structuredClone(args),
            state: 'inflight', dispatched_outcome: 'unknown', attempted_at: new Date().toISOString() };
          plan.browser_write_attempts.push(intent);
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
            ? completeOperationReceipt(name, intent.arguments, intent.record_ids, receipt, intent.attempted_at) : null;
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
        refusals.push(gap);
        scope?.refusals.push(gap);
        // Refusal metadata contains no URL, arguments, record IDs or payload.
        // Failure to retain it never permits dispatch or clears an intent.
        try {
          await locked(async () => {
            const plan = planPath ? await readPrivateJSON(planPath) : null;
            if (plan?.schema === 'doctorcre-staging-records-plan.v1' && plan.state === 'complete') {
              plan.browser_write_refusals ||= []; plan.browser_write_refusals.push(gap);
              await persist(planPath, plan);
            }
          });
        } catch {}
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
