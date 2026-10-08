import { constants } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as playwrightRequest } from 'playwright';
import { assertStagingURL, chargeBody, stagingSession, STAGING_ORIGIN } from './session.mjs';
import { BudgetRefusal } from './run-budget.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { eligibleLead } from '../../js/leads-model.js';

const FIXTURE = { id: 'fc08d2f4-a951-5679-9f34-40d0f4278842', name: 'Synthetic Staging Fixture' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = () => { throw new Error('Staging record contract refused'); };
const requireValue = condition => { if (!condition) fail(); };
const recordId = value => { requireValue(UUID.test(value || '')); return value; };

async function privateJSON(path, value, exclusive = false) {
  const destination = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
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

// The pinned CARR interface has no verb that removes or archives a synthetic
// party, client, deal, lead, conversation or tour. A run may only create a
// fixture it can remove again, so fresh fixture creation stays refused until
// each record kind has a pinned removal verb here.
export const REMOVAL_VERBS = Object.freeze({});
const FIXTURE_KINDS = ['party', 'client', 'deal', 'invoice', 'lead_party', 'lead', 'conversation', 'tour'];

const defaultRequestFactory = options => playwrightRequest.newContext(options);

// Every request through a budgeted API is a charged dispatch; its response
// body is charged as ingress.
function budgetedApi(api, budget) {
  const send = (method, kind) => (path, options) => budget.dispatch(kind, async () => chargeBody(budget, await api[method](path, options)));
  return {
    get: send('get', 'http'),
    post: (path, options) => send('post', options?.data?.method === 'tools/call' && !READ_RPCS.has(options.data.params?.name) ? 'mutation' : 'http')(path, options),
    dispose: () => api.dispose(),
  };
}
const READ_RPCS = new Set(['get-deal-room', 'read-deal-reconciliation', 'read-invoice-tracker', 'lead-board', 'read-doc-conversation']);

// Removes the fixtures one run created, each removal charged as a mutation on
// the same budget. The first failure stops the run and writes a receipt naming
// every record left behind.
export async function cleanupStagingRecords({ budget, created, remove = unavailableRemoval }) {
  const removed = [];
  for (const [index, entry] of created.entries()) {
    try {
      await budget.dispatch('mutation', () => remove(entry));
      removed.push(entry.id);
    } catch (error) {
      const left_behind = created.slice(index).map(({ record, id }) => ({ record, id }));
      const code = error instanceof BudgetRefusal && error.code !== 'cleanup-unavailable' ? error.code : 'cleanup-failed';
      await budget.stop(code).catch(() => {});
      await budget.finish({ schema: 'sweep-explore-receipt.v1', qualified: false, removed, left_behind, failure: { phase: 'cleanup', code } }).catch(() => {});
      throw new BudgetRefusal(code);
    }
  }
  return { removed, left_behind: [] };
}

// No record kind has a pinned removal verb yet (see REMOVAL_VERBS).
async function unavailableRemoval() {
  throw new BudgetRefusal('cleanup-unavailable');
}

export async function prepareStagingRecords(output, {
  origin = STAGING_ORIGIN, session = stagingSession, reuseOnly = false, budget,
  requestFactory = defaultRequestFactory,
} = {}) {
  origin = assertStagingURL(origin);
  const planPath = join(output, 'staging-records-plan.json');
  const existing = await readPrivateJSON(planPath);
  if (existing && (existing.state !== 'complete' || existing.inflight)) throw new Error('Staging records partial plan requires reconciliation; no record write was retried');
  if (!budget && requestFactory === defaultRequestFactory) throw new BudgetRefusal('http-not-budgeted');
  if (budget && !existing && FIXTURE_KINDS.some(kind => !REMOVAL_VERBS[kind])) throw new BudgetRefusal('cleanup-unavailable');
  if (reuseOnly && (!existing || existing.schema !== 'doctorcre-staging-records-plan.v1' || existing.origin !== STAGING_ORIGIN ||
      !/^[0-9a-f]{40}$/.test(existing.release?.source_commit || '') || existing.release?.carr_source_commit !== contract.producer.source_commit ||
      ['party', 'client', 'deal', 'lead_party', 'lead', 'conversation', 'tour'].some(name => !UUID.test(existing.records?.[name]?.id || '')) || !UUID.test(existing.records?.invoice?.deal_id || ''))) {
    throw new Error('Resume requires an existing complete private staging records plan; no record write was attempted');
  }
  const { state, release } = await session(origin);
  if (release?.environment !== 'staging' || release?.service !== 'doctorcre-app' ||
      !/^[0-9a-f]{40}$/.test(release?.source_commit || '') || release?.carr_source_commit !== contract.producer.source_commit) {
    throw new Error('Staging records require the exact pinned staging source pair');
  }
  const source = { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit };
  if (existing && (existing.schema !== 'doctorcre-staging-records-plan.v1' || existing.origin !== STAGING_ORIGIN ||
      existing.release?.source_commit !== source.source_commit || existing.release?.carr_source_commit !== source.carr_source_commit)) {
    throw new Error('Staging records completed plan differs from the exact source pair');
  }
  const run = existing?.run || randomUUID();
  const label = `Synthetic staging QA ${run}`;
  const plan = existing || {
    schema: 'doctorcre-staging-records-plan.v1', origin, release: source, state: 'pending', run,
    keys: Object.fromEntries(['party', 'client', 'deal', 'deal_lead', 'invoice_deal', 'invoice_lead', 'close_invoice', 'lead_party', 'lead', 'conversation', 'tour'].map(name => [name, randomUUID()])),
    names: { deal: `${label} active deal`, invoice: `${label} closed deal`, lead: `QA Unlinked Prospect ${run}`, conversation: `${label} private conversation`, tour: `${label} draft tour` },
    records: {}, receipts: {}, current_step: 'authentication', observed_at: new Date().toISOString(),
  };
  plan.current_step = 'authentication';
  let api;
  const headers = { origin: STAGING_ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  try {
    api = await requestFactory({ baseURL: STAGING_ORIGIN, storageState: state, timeout: budget ? budget.timeoutMs() : 30_000 });
    if (budget) api = budgetedApi(api, budget);
    async function json(path, data) {
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
    const actor = await json('/auth/session');
    requireValue(actor.actor?.slug === 'joe' && actor.e2e_principal === 'e2e-joe' && typeof actor.csrf_token === 'string' && actor.csrf_token);
    if (!existing) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      await privateJSON(planPath, plan, true);
    }
    async function write(step, name, args) {
      plan.current_step = step;
      plan.inflight = { name, arguments: { ...args, idempotency_key: plan.keys[step] } };
      await privateJSON(planPath, plan);
      const result = await rpc(name, plan.inflight.arguments);
      plan.receipts[step] = Object.fromEntries(['party_id', 'client_id', 'deal_id', 'lead_id', 'conversation_id'].filter(field => UUID.test(result[field] || '')).map(field => [field, result[field]]));
      plan.inflight = null;
      await privateJSON(planPath, plan);
      return result;
    }
    async function remember(name, record) { plan.records[name] = record; await privateJSON(planPath, plan); }
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
      await privateJSON(planPath, plan);
      const tour = await api.post('/api/tours/create', {
        maxRedirects: 0, headers: { ...headers, 'x-carr-csrf': actor.csrf_token },
        data: plan.inflight.arguments,
      });
      requireValue(tour.ok());
      await remember('tour', { id: recordId((await tour.json()).data?.tour_id), name: plan.names.tour });
      plan.inflight = null;
    }
    plan.current_step = 'readback';
    await privateJSON(planPath, plan);
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
    requireValue(tourRead?.id === plan.records.tour.id && UUID.test(tourRead.subject_id || '') && boundedText(tourRead.subject_type));
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
    budget?.tagFixtures(Object.values(plan.records).flatMap(record => [record.id, record.deal_id, record.ref]));
    await privateJSON(join(output, 'staging-records.json'), result);
    plan.state = 'complete';
    await privateJSON(planPath, plan);
    return result;
  } catch (error) {
    if (error instanceof BudgetRefusal) throw error;
    throw new Error(`Staging records setup stopped at ${plan.current_step}; partial plan requires reconciliation; no request or provider payload was logged`);
  } finally { if (api) await api.dispose().catch(() => {}); }
}
