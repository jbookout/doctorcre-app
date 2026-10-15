import { requireSupervisedRun, effectiveRunLimits, RunLimitError } from './run-limits.mjs';
import { constants } from 'node:fs';
import { mkdir, open, rename, readFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { assertStagingURL, createStagingRequestContext, stagingSession, STAGING_ORIGIN } from './session.mjs';
import { stagingAuth } from './auth-contract.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import appRoutes from '../../contracts/app-routes.v1.json' with { type: 'json' };
import { eligibleLead } from '../../js/leads-model.js';
import { COLUMNS } from '../../js/pipeline-model.js';
import { sourceIsFresh } from '../../js/workspace-business-model.js';
import { prepareBrowserControlProofs, validControlProof } from './control-proofs.mjs';
import businessJourneys from '../../contracts/e2e-staging-business-journeys.v1.json' with { type: 'json' };
import invoiceJourney from '../../contracts/e2e-staging-invoice-journey.v1.json' with { type: 'json' };
import { validInvoiceTracker } from '../../js/invoice-tracker-model.js';
import { LOCAL_AGENT_PHASE_REASON } from './local-agent-phase.mjs';
import { createInvoiceCloseGuard } from './invoice-close-journey.mjs';
import { createCompanionGuard } from './companion-guard.mjs';
import { assertRelationshipFixture } from './readonly-journeys.mjs';
import { validNetwork, filterNetwork } from '../../js/relationship-network-model.js';

const FIXTURE = { id: 'fc08d2f4-a951-5679-9f34-40d0f4278842', name: 'Synthetic Staging Fixture' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUUID = value => typeof value === 'string' && UUID.test(value);
const fail = () => { throw new Error('Staging record contract refused'); };
const requireValue = condition => { if (!condition) fail(); };
const recordId = value => { requireValue(isUUID(value || '')); return value; };
const vendorTaxonomyFailure = code => Object.assign(new Error('Staging vendor taxonomy prerequisite unavailable'), { code });
const SAFE_RECORD_SETUP_CODES = new Set(['staging-fixture-rpc-unresolved', 'staging-fixture-stage-prerequisite',
  'staging-fixture-taxonomy-prerequisite', 'staging-fixture-category-prerequisite', 'staging-fixture-relationship-prerequisite']);

const TOOL_ERROR_CODES = new Set([
  'database_refused_the_statement', 'invalid_arguments', 'not_found', 'not_in_profile',
  'research_evidence_incomplete', 'research_evidence_required', 'research_source_invalid',
  'stale_version', 'unknown_vendor_stage', 'unhandled_verb_failure', 'unauthorized',
  'version_conflict', 'invalid_received_on', 'invoice_not_found', 'invoice_not_unpaid', 'payment_date_out_of_range',
]);
const JSON_RPC_ERROR_CODES = new Map([
  [-32700, 'json-rpc-parse-error'], [-32600, 'json-rpc-invalid-request'],
  [-32601, 'json-rpc-method-not-found'], [-32602, 'json-rpc-invalid-params'],
  [-32603, 'json-rpc-internal-error'],
]);
const RAW_RESPONSE_SHA256 = Symbol('raw-response-sha256');
const paymentRefusalCodes = new Set(['invalid_received_on', 'invoice_not_found', 'version_conflict',
  'invoice_not_unpaid', 'payment_date_out_of_range']);

export function verifiedPreEffectRefusal(operation, args, rpc, requestId, httpStatus) {
  if (operation !== 'record-commission-receipt' || httpStatus !== 200 || rpc?.jsonrpc !== '2.0' ||
      rpc.id !== requestId || rpc.error || rpc.result?.isError !== true ||
      rpc.result.content?.length !== 1 || rpc.result.content[0]?.type !== 'text') return null;
  let value;
  try { value = JSON.parse(rpc.result.content[0].text); } catch { return null; }
  if (!paymentRefusalCodes.has(value?.error) || Object.keys(value).some(key =>
      !['error', 'current_version'].includes(key)) || value.error === 'version_conflict' &&
      (!Number.isSafeInteger(value.current_version) || value.current_version < 1) ||
      value.error !== 'version_conflict' && Object.hasOwn(value, 'current_version')) return null;
  return { code: value.error, operation, arguments_sha256: digest(args), response_sha256: digest(rpc) };
}

function validPreEffectRefusal(row) {
  const response = row.response;
  const refusal = verifiedPreEffectRefusal(row.operation, row.arguments, response?.envelope,
    response?.request_id, response?.http_status);
  return row.state === 'refused' && row.dispatched_outcome === 'verified pre-effect refusal' &&
    response?.acknowledged === false && refusal && digest(refusal) === digest(response.refusal);
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const digestJSON = value => {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { serialized = undefined; }
  return sha256(serialized === undefined ? 'unserializable-json-rpc-reply' : serialized);
};

/** Parse the staging MCP envelope without retaining or exposing provider text. */
export function parseStagingRPCReply(answer, expectedId) {
  const response_sha256 = answer?.[RAW_RESPONSE_SHA256] || digestJSON(answer);
  const malformed = () => ({ value: null, failure: { code: 'malformed-rpc-reply', response_sha256 } });
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || answer.jsonrpc !== '2.0' ||
      answer.id !== expectedId || (Object.hasOwn(answer, 'error') && Object.hasOwn(answer, 'result'))) return malformed();

  if (Object.hasOwn(answer, 'error')) {
    const error = answer.error;
    if (!error || typeof error !== 'object' || Array.isArray(error) || !Number.isInteger(error.code) ||
        typeof error.message !== 'string') return malformed();
    return { value: null, failure: { code: JSON_RPC_ERROR_CODES.get(error.code) || 'json-rpc-error', response_sha256 } };
  }

  const result = answer.result;
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      (Object.hasOwn(result, 'isError') && typeof result.isError !== 'boolean') || !Array.isArray(result.content)) return malformed();
  const texts = result.content.filter(item => item?.type === 'text' && typeof item.text === 'string');
  if (!texts.length) return malformed();
  let value;
  try { value = JSON.parse(texts[0].text); } catch { return malformed(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed();
  if (result.isError === true || Object.hasOwn(value, 'error')) {
    const code = typeof value.error === 'string' && TOOL_ERROR_CODES.has(value.error) ? value.error : 'tool-error';
    return { value, failure: { code, response_sha256 } };
  }
  return { value, failure: null };
}

class StagingRPCFailure extends Error {
  constructor(failure) {
    super('Staging RPC reply unresolved');
    this.name = 'StagingRPCFailure';
    this.code = failure.code;
    this.response_sha256 = failure.response_sha256;
  }
}

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

const relationshipFailure = () => {
  throw Object.assign(new Error('Staging relationship fixture proof prerequisite unavailable'),
    { code: 'staging-fixture-relationship-prerequisite' });
};
function relationshipFixtureId(run, role) {
  const bytes = createHash('sha1').update(Buffer.from('439206abd73a5c1b8a20531e536e5804', 'hex'))
    .update(`relationship:${role}:${run}`).digest().subarray(0, 16);
  bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128;
  const id = bytes.toString('hex');
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}
function verifiedFixtureTarget(target) {
  const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
    digest(Object.keys(value).sort()) === digest([...expected].sort());
  const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  return keys(target, ['project', 'branch', 'endpoint', 'database']) &&
    keys(target.project, ['id', 'name']) && keys(target.branch, ['id', 'name']) && keys(target.endpoint, ['id', 'host']) &&
    text(target.project.id, 128) && target.project.id !== 'steep-field-48688294' &&
    text(target.project.name, 256) && target.project.name.startsWith('carr-staging-replacement-') &&
    text(target.branch.id, 128) && target.branch.name === 'main' && text(target.endpoint.id, 128) &&
    target.endpoint.id.startsWith('ep-') && text(target.endpoint.host, 253) && /^[a-z0-9.-]+$/.test(target.endpoint.host) &&
    target.endpoint.host.startsWith(target.endpoint.id + '.') && target.endpoint.host.endsWith('.neon.tech') &&
    target.database === 'neondb';
}
function relationshipProjection(network, plan, rows) {
  if (!validNetwork(network)) relationshipFailure();
  const { party, client, deal, vendor, vendor_party: vendorParty, relationship_referral_deal: referred } = plan.records;
  const nodeIds = [`party:${party.id}`, `deal:${deal.id}`, `party:${vendorParty.id}`,
    `party:${referred.party_id}`, `deal:${referred.id}`];
  const edgeIds = [`client-deal:${deal.id}`, `client-deal:${referred.id}`,
    `evidence:${party.id}:${referred.id}:referred`, `evidence:${vendorParty.id}:${deal.id}:referred`];
  const nodes = nodeIds.map(id => {
    const rows = network.nodes.filter(row => row.id === id);
    if (rows.length !== 1) relationshipFailure();
    const row = rows[0];
    return { id, kind: row.kind, record_id: row.record_id, name: row.name, territory: row.territory ?? null };
  });
  const edges = edgeIds.map(id => {
    const rows = network.edges.filter(row => row.id === id);
    if (rows.length !== 1) relationshipFailure();
    const row = rows[0];
    return { id, from: row.from, to: row.to, kind: row.kind, via: row.via, detail: row.detail ?? null };
  });
  const north = rows.fixed_party.city, south = rows.owned_vendor.territory;
  const expectedNodes = [
    { id: nodeIds[0], kind: 'client', record_id: client.id, name: party.name, territory: north },
    { id: nodeIds[1], kind: 'deal', record_id: deal.id, name: deal.name, territory: nodes[1].territory },
    { id: nodeIds[2], kind: 'vendor', record_id: vendor.id, name: vendor.name, territory: south },
    { id: nodeIds[3], kind: 'client', record_id: referred.client_id,
      name: rows.destination_party.name, territory: north },
    { id: nodeIds[4], kind: 'deal', record_id: referred.id, name: referred.name, territory: nodes[4].territory },
  ];
  const expectedEdges = [
    { id: edgeIds[0], from: nodeIds[0], to: nodeIds[1], kind: 'client_deal', via: null, detail: null },
    { id: edgeIds[1], from: nodeIds[3], to: nodeIds[4], kind: 'client_deal', via: null, detail: null },
    { id: edgeIds[2], from: nodeIds[0], to: nodeIds[4], kind: 'referred', via: null, detail: rows.referral_association.note },
    { id: edgeIds[3], from: nodeIds[2], to: nodeIds[1], kind: 'referred', via: null, detail: rows.vendor_association.note },
  ];
  const metrics = [nodeIds[0], nodeIds[2]].map(id => network.referrals.filter(row => row.node_id === id));
  if (digest(nodes) !== digest(expectedNodes) || digest(edges) !== digest(expectedEdges) || metrics.some(rows =>
      rows.length !== 1 || rows[0].deals < 1)) relationshipFailure();
  return { nodes, edges, metrics: metrics.map(rows => rows[0]), total_referrals: network.referrals.length,
    same_territory_referrals: filterNetwork(network, { territory: north }).referrals.length,
    other_territory_referrals: network.referrals.filter(row => {
      const node = network.nodes.find(node => node.id === row.node_id);
      return typeof node?.territory === 'string' && node.territory.trim() && node.territory !== north;
    }).length };
}
function validateRelationshipProof(proof, plan, target) {
  if (!verifiedFixtureTarget(target) || digest(proof?.verified_target || null) !== digest(target) ||
      proof?.schema !== 'doctorcre-staging-relationship-fixture.v1' || proof.fixture_run !== plan.run ||
      digest(proof.source_pair || null) !== digest(plan.release) || proof.recorded_plan_observed_at !== plan.observed_at ||
      digest(proof.provenance || null) !== digest({ kind: 'raw-sql-fixture', readback: 'separate-committed-readonly-connection' }) ||
      proof.party_id !== plan.records.party.id || proof.client_id !== plan.records.client.id || proof.deal_id !== plan.records.deal.id ||
      !isUUID(plan.records.vendor?.id) || !isUUID(plan.records.vendor_party?.id) ||
      plan.receipts.vendor?.vendor_id !== plan.records.vendor.id || plan.receipts.vendor_party?.party_id !== plan.records.vendor_party.id)
    relationshipFailure();
  const label = `Synthetic staging QA ${plan.run}`, north = 'Synthetic Staging QA North', south = 'Synthetic Staging QA South';
  const id = role => relationshipFixtureId(plan.run, role);
  const note = role => `Fictional staging QA ${role} referral for fixture ${plan.run}.`;
  const association = (role, from, to) => ({ id: id(role), from_party_id: from, to_party_id: to,
    kind: 'referred', via_party_id: null, occurred_on: plan.observed_at.slice(0,10), note: note(role), attribution: 'system' });
  const attribution = (role, party, deal, noteRole) => ({ id: id(role), party_id: party, deal_id: deal,
    kind: 'referred', via_party_id: null, occurred_on: plan.observed_at.slice(0,10), note: note(noteRole), attribution: 'system' });
  const rows = {
    destination_party: { id: id('destination_party'), name: `${label} referred client`, kind: 'org', city: north },
    destination_client: { id: id('destination_client'), party_id: id('destination_party'), status: 'engaged' },
    destination_deal: { id: id('destination_deal'), name: `${label} referred deal`, client_id: id('destination_client'),
      owner: 'joe', phase: 'pending', lane: 'territory', deal_type: 'startup' },
    fixed_party: { id: plan.records.party.id, city: north },
    owned_vendor: { id: plan.records.vendor.id, party_id: plan.records.vendor_party.id, territory: south },
    referral_association: association('referral_association', plan.records.party.id, id('destination_party')),
    vendor_association: association('vendor_association', plan.records.vendor_party.id, plan.records.party.id),
    referral_attribution: attribution('referral_attribution', plan.records.party.id, id('destination_deal'), 'referral_association'),
    vendor_attribution: attribution('vendor_attribution', plan.records.vendor_party.id, plan.records.deal.id, 'vendor_association'),
  };
  const referred = { id: rows.destination_deal.id, name: rows.destination_deal.name,
    client_id: rows.destination_client.id, party_id: rows.destination_party.id };
  const tables = { destination_party: 'party', destination_client: 'client', destination_deal: 'deal', fixed_party: 'party',
    owned_vendor: 'vendor', referral_association: 'party_association', vendor_association: 'party_association',
    referral_attribution: 'deal_attribution', vendor_attribution: 'deal_attribution' };
  const rowHashes = Object.fromEntries(Object.entries(rows).map(([role, row]) => [role, digest(row)]));
  const receipts = Object.fromEntries(Object.entries(rows).map(([role, row]) => {
    const field = role === 'fixed_party' ? 'city' : role === 'owned_vendor' ? 'territory' : null;
    const before = proof.receipts?.[role]?.before_sha256;
    if (field && before !== digest({ ...row, [field]: null }) && before !== digest(row)) relationshipFailure();
    return [role, { operation: field ? 'update' : 'insert', table: tables[role], row_id: row.id,
      before_sha256: field ? before : null, after_sha256: rowHashes[role] }];
  }));
  if (digest(proof.rows || null) !== digest(rows) || digest(proof.row_sha256 || null) !== digest(rowHashes) ||
      digest(proof.receipts || null) !== digest(receipts) || digest(proof.relationship_referral_deal || null) !== digest(referred) ||
      digest(proof.original_note_sha256 || null) !== digest({ referral: sha256(note('referral_association')), vendor: sha256(note('vendor_association')) }) ||
      !proof.projection?.response || proof.projection.response_sha256 !== digest(proof.projection.response)) relationshipFailure();
  const candidate = { ...plan, records: { ...plan.records, relationship_referral_deal: referred } };
  const installedAt = Date.parse(proof.projection.response.observed_at);
  if (!Number.isFinite(installedAt) || installedAt < Date.parse(plan.observed_at) - 5000 || installedAt > Date.now() + 5000)
    relationshipFailure();
  return { referred, rows, candidate, installedAt, projection: relationshipProjection(proof.projection.response, candidate, rows) };
}

export async function prepareStagingRecords(output, {
  origin = STAGING_ORIGIN, session = stagingSession, reuseOnly = false,
  vendorFixture = false, tourDraftFixture = false, awaitingInvoiceFixture = false, relationshipFixture = false,
  relationshipFixtureProofPath = join(output, 'private', 'relationship-fixture-proof.json'), relationshipFixtureTarget, requestFactory, run, signal,
} = {}) {
  signal?.throwIfAborted();
  origin = assertStagingURL(origin);
  relationshipFixtureTarget = relationshipFixtureTarget && structuredClone(relationshipFixtureTarget);
  run = requireSupervisedRun(output, run);
  signal ??= run.signal;
  const persist = (path, value, exclusive) => privateJSON(path, value, exclusive, run);
  const planPath = join(output, 'staging-records-plan.json');
  const existing = await readPrivateJSON(planPath);
  if (existing && (existing.state !== 'complete' || existing.inflight)) throw new Error('Staging records partial plan requires reconciliation; no record write was retried');
  if (relationshipFixture && existing && (existing.fixture_proofs?.relationship || existing.relationship_fixture)) {
    const retained = existing.fixture_proofs?.relationship;
    if (retained && typeof retained === 'object' && !Array.isArray(retained)) {
      if (retained.state === 'verified') retained.state = 'pending-readback';
      delete retained.current_readback;
    }
    delete existing.relationship_fixture;
    await persist(planPath, existing);
  }
  if (reuseOnly && tourDraftFixture && existing) {
    const parts = [
      [existing.records?.tour_draft_party, existing.receipts?.tour_draft_party],
      [existing.records?.tour_draft_client, existing.receipts?.tour_draft_client],
    ];
    const present = parts.flat().filter(Boolean).length;
    if (present !== 0 && present !== parts.length * 2) {
      throw new Error('Staging Tour draft client fixture partial plan requires reconciliation; no record write was retried');
    }
  }
  if (reuseOnly && awaitingInvoiceFixture && existing) {
    const awaitingReceipts = ['awaiting_invoice_deal', 'awaiting_invoice_lead', 'awaiting_invoice_close'];
    const received = awaitingReceipts.filter(step => existing.receipts?.[step]);
    if ((existing.records?.awaiting_invoice && received.length !== awaitingReceipts.length) ||
        (!existing.records?.awaiting_invoice && received.length)) {
      throw new Error('Staging awaiting-invoice fixture partial plan requires reconciliation; no record write was retried');
    }
  }
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
    keys: Object.fromEntries(['party', 'client', 'deal', 'deal_lead', 'invoice_deal', 'invoice_lead', 'close_invoice', 'lead_party', 'vendor_party', 'lead', 'conversation', 'tour', 'tour_draft_party', 'tour_draft_client', 'awaiting_invoice_deal', 'awaiting_invoice_lead', 'awaiting_invoice_close'].map(name => [name, randomUUID()])),
    names: { deal: `${label} active deal`, invoice: `${label} closed deal`, awaiting_invoice: `${fixtureRun} Synthetic W15 awaiting invoice`, conversation: `${label} private conversation`, tour: `${label} draft tour` },
    records: {}, receipts: {}, current_step: 'authentication', observed_at: new Date().toISOString(),
  };
  if (!existing) plan.names.lead = `QA Lead ${plan.keys.lead_party}`;
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
      if (path === '/mcp') {
        const raw = await response.text();
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') Object.defineProperty(parsed, RAW_RESPONSE_SHA256, { value: sha256(raw) });
          return parsed;
        }
        catch { throw new StagingRPCFailure({ code: 'malformed-rpc-reply', response_sha256: sha256(raw) }); }
      }
      return response.json();
    }
    let sequence = 0;
    async function rpc(name, args = {}, notFoundDealID) {
      const id = ++sequence;
      const answer = await json('/mcp', { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      const parsed = parseStagingRPCReply(answer, id);
      if (parsed.failure) {
        if (existing && name === 'get-deal-room' && notFoundDealID && parsed.failure.code === 'not_found' &&
            parsed.value?.table === 'deal' && parsed.value?.id === notFoundDealID) return parsed.value;
        throw new StagingRPCFailure(parsed.failure);
      }
      return parsed.value;
    }
    const actor = await json(stagingAuth.session.path);
    requireValue(stagingAuth.session.matches(actor) && typeof actor.csrf_token === 'string' && actor.csrf_token);
    if (vendorFixture && !plan.records.vendor) {
      const taxonomy = await json('/api/v1/business/vendors?contract=vendor-directory.v1');
      const facets = taxonomy?.facets;
      const facetList = value => Array.isArray(value) && value.every(row => row &&
        typeof row.slug === 'string' && row.slug.length > 0 && typeof row.label === 'string' && row.label.length > 0);
      const observedAt = Date.parse(taxonomy?.source?.observed_at);
      if (taxonomy?.viewer !== 'joe' || taxonomy.dataset !== 'vendors' || !sourceIsFresh(taxonomy.source, 'vendors') ||
          !Number.isFinite(observedAt) || observedAt > Date.now() + 5000 || !facetList(facets?.categories) ||
          !facetList(facets?.stages)) throw vendorTaxonomyFailure('staging-fixture-taxonomy-prerequisite');
      if (!facets.stages.some(row => row.slug === 'prospect_uncontacted'))
        throw vendorTaxonomyFailure('staging-fixture-stage-prerequisite');
      if (!facets.categories.some(row => row.slug === 'cpa' && row.label === 'CPA / Financial'))
        throw vendorTaxonomyFailure('staging-fixture-category-prerequisite');
    }
    if (!existing) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      await persist(planPath, plan, true);
    }
    async function write(step, name, args) {
      signal?.throwIfAborted();
      requireValue(!Object.hasOwn(args, 'force_new'));
      plan.current_step = step;
      plan.inflight = { name, arguments: { ...args, idempotency_key: plan.keys[step] } };
      await persist(planPath, plan);
      signal?.throwIfAborted();
      let result;
      try { result = await rpc(name, plan.inflight.arguments); }
      catch (error) {
        if (!(error instanceof StagingRPCFailure)) throw error;
        plan.rpc_failures ||= [];
        plan.rpc_failures.push({ schema: 'doctorcre-staging-rpc-failure.v1', step, operation: name,
          code: error.code, observed_at: new Date().toISOString(),
          request_sha256: sha256(JSON.stringify(plan.inflight.arguments)),
          response_sha256: error.response_sha256 });
        // The write may have committed before this response arrived. Keep its exact
        // durable intent and quarantine the plan; never represent this as no effect.
        plan.state = 'blocked';
        await persist(planPath, plan);
        throw Object.assign(new Error('Staging RPC reply unresolved; reconciliation required'),
          { code: 'staging-fixture-rpc-unresolved' });
      }
      if (step === 'party' && result.needs_confirm === true &&
          result.candidates?.filter(row => row.id === FIXTURE.id && row.name === FIXTURE.name).length === 1) {
        plan.inflight = null;
        await persist(planPath, plan);
        return result;
      }
      if (result.needs_confirm === true || result.ok !== true) {
        const candidates = Array.isArray(result.candidates) ? result.candidates : [];
        plan.refusals ||= [];
        plan.refusals.push({ schema: 'doctorcre-staging-fixture-refusal.v1', step, operation: name,
          code: result.needs_confirm === true ? 'candidate-confirmation-required' : 'producer-nonacknowledgment',
          observed_at: new Date().toISOString(),
          request_sha256: createHash('sha256').update(JSON.stringify(plan.inflight.arguments)).digest('hex'),
          response_sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
          candidate_count: candidates.length,
          candidates: candidates.slice(0, 5).filter(row => isUUID(row?.id)).map(row => ({
            id: row.id, name_sha256: createHash('sha256').update(String(row.name || '')).digest('hex'),
            exact_email_match: row.exact_email_match === true })) });
        plan.state = 'blocked';
        plan.inflight = null;
        await persist(planPath, plan);
        throw Object.assign(new Error('Staging fixture producer acknowledgment refused'),
          { code: 'staging-fixture-candidate-refused' });
      }
      if (step.startsWith('awaiting_invoice_')) {
        // Keep the producer's full response as the immutable fixture receipt.
        // The request intent is already on disk, and retries are refused while
        // any part of this sequence is incomplete.
        plan.receipts[step] = structuredClone(result);
        if (step === 'awaiting_invoice_deal') {
          requireValue(result.ok === true && isUUID(result.deal_id || '') &&
            result.name === plan.names.awaiting_invoice && result.client_ref === plan.records.client.ref);
          plan.records.awaiting_invoice = { deal_id: recordId(result.deal_id), name: result.name };
        }
      } else {
        plan.receipts[step] = Object.fromEntries(['party_id', 'client_id', 'deal_id', 'lead_id', 'conversation_id', 'vendor_id', 'activity_id']
          .filter(field => isUUID(result[field] || '')).map(field => [field, result[field]]));
      }
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
        plan.party_reuse = { schema: 'staging-fixture-party-reuse.v1', state: 'pending-readback',
          party_id: FIXTURE.id, candidate_response_sha256: digest(party),
          observed_at: new Date().toISOString() };
        await persist(planPath, plan);
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
    if (vendorFixture) {
      const vendorParts = ['vendor_party', 'vendor', 'vendor_entry'];
      const present = vendorParts.filter(name => plan.records[name]);
      if (present.length && present.length !== vendorParts.length) throw new Error('Staging vendor fixture partial; reconciliation required');
      if (!present.length) {
        for (const name of vendorParts) plan.keys[name] ||= randomUUID();
        plan.names.vendor ||= `QA Vendor ${plan.keys.vendor_party}`;
        await persist(planPath, plan);
        const party = await write('vendor_party', 'add-party', { name: plan.names.vendor, kind: 'org' });
        requireValue(party.ok === true && !party.auto_resolved && !party.needs_confirm);
        await remember('vendor_party', { id: recordId(party.party_id), name: plan.names.vendor });
        const vendor = await write('vendor', 'new-vendor', { party_id: plan.records.vendor_party.id,
          category: 'cpa', ref_code: 'CPA', stage: 'prospect_uncontacted',
          research_evidence: {
            sources: [{ url: 'https://practice.example/vendor?fixture=synthetic-staging-qa-v1', observed_at: plan.observed_at }],
            field_evidence: Object.fromEntries(['company', 'title', 'category', 'market', 'phone', 'website', 'deal_side']
              .map(field => [field, [0]])), discrepancies: [],
          } });
        requireValue(vendor.ok === true && /^V-CPA-\d+$/.test(vendor.ref || ''));
        await remember('vendor', { id: recordId(vendor.vendor_id), ref: vendor.ref, name: plan.names.vendor });
        const entry = await write('vendor_entry', 'log-activity', { ref: vendor.ref, kind: 'note',
          summary: 'Synthetic staging QA introduction entry',
          detail: 'Fictional QA evidence only; no contact, referral, or send occurred.',
          links: [{ from_ref: vendor.ref, to_ref: plan.records.client.ref, kind: 'can_introduce',
            note: 'Synthetic staging QA suggested introduction only; no real-world introduction occurred.' }] });
        requireValue(entry.ok === true && entry.links?.length === 1 && entry.links[0].existing === false &&
          entry.links[0].from_ref === vendor.ref && entry.links[0].to_ref === plan.records.client.ref &&
          entry.links[0].kind === 'can_introduce');
        await remember('vendor_entry', { id: recordId(entry.activity_id), link_id: recordId(entry.links[0].link_id) });
      }
    }
    if (tourDraftFixture) {
      const fixtureParts = ['tour_draft_party', 'tour_draft_client'];
      const present = fixtureParts.filter(name => plan.records[name]);
      if (present.length && present.length !== fixtureParts.length)
        throw new Error('Staging Tour draft client fixture partial; reconciliation required');
      if (!present.length) {
        // Persist unique names and both write keys before the first normal CARR
        // mutation. The fixed base fixture remains untouched.
        for (const name of fixtureParts) plan.keys[name] ||= randomUUID();
        plan.names.tour_draft_party ||= `QA Tour ${plan.keys.tour_draft_party}`;
        // CARR derives the client display name from its canonical party.
        plan.names.tour_draft_client ||= plan.names.tour_draft_party;
        await persist(planPath, plan);
        const party = await write('tour_draft_party', 'add-party', {
          name: plan.names.tour_draft_party, kind: 'org', city: 'Pensacola', state: 'FL',
        });
        requireValue(party.ok === true && !party.auto_resolved && !party.needs_confirm &&
          isUUID(party.party_id || '') && plan.receipts.tour_draft_party?.party_id === party.party_id);
        await remember('tour_draft_party', { id: recordId(party.party_id), name: plan.names.tour_draft_party,
          city: 'Pensacola', state: 'FL' });
        const client = await write('tour_draft_client', 'new-client', {
          party_id: plan.records.tour_draft_party.id, status: 'engaged', acquisition_source: 'referral',
          acquisition_detail: 'Explicitly fictional W6 staging QA fixture only',
          research_evidence: {
            sources: [{ url: 'https://practice.example/w6-tour-draft?fixture=synthetic-staging-qa-v1', observed_at: plan.observed_at }],
            field_evidence: Object.fromEntries(['practice_name', 'address', 'city', 'state', 'phone', 'specialty', 'practitioners', 'hours'].map(field => [field, [0]])),
            discrepancies: [],
          },
        });
        requireValue(client.ok === true && /^C-\d+$/.test(client.ref || '') && isUUID(client.client_id || '') &&
          plan.receipts.tour_draft_client?.client_id === client.client_id);
        await remember('tour_draft_client', { id: recordId(client.client_id), ref: client.ref,
          name: plan.names.tour_draft_client, party_id: plan.records.tour_draft_party.id });
      }
    }
    if (awaitingInvoiceFixture) {
      const receiptSteps = ['awaiting_invoice_deal', 'awaiting_invoice_lead', 'awaiting_invoice_close'];
      const present = receiptSteps.filter(step => plan.receipts[step]);
      const record = plan.records.awaiting_invoice;
      if ((record && present.length !== receiptSteps.length) || (!record && present.length))
        throw new Error('Staging awaiting-invoice fixture partial; reconciliation required');
      if (!record) {
        for (const step of receiptSteps) plan.keys[step] ||= randomUUID();
        plan.names.awaiting_invoice ||= `${plan.run} Synthetic W15 awaiting invoice`;
        await persist(planPath, plan);
        const created = await write('awaiting_invoice_deal', 'new-deal', {
          client: plan.records.client.ref, name: plan.names.awaiting_invoice, deal_type: 'startup',
          phase: 'pending', lane: 'territory', reason: 'Explicitly fictional W15 awaiting-invoice staging QA fixture only',
        });
        const dealId = plan.records.awaiting_invoice?.deal_id;
        requireValue(created.ok === true && dealId === created.deal_id &&
          plan.receipts.awaiting_invoice_deal?.deal_id === dealId);
        const beforeLead = await rpc('get-deal-room', { deal: dealId });
        requireValue(beforeLead.deal_id === dealId && beforeLead.name === plan.names.awaiting_invoice &&
          beforeLead.client_ref === plan.records.client.ref && beforeLead.phase === 'pending' &&
          Number.isInteger(beforeLead.base_version));
        const lead = await write('awaiting_invoice_lead', 'set-lead', {
          deal: dealId, new_lead: 'joe', base_version: beforeLead.base_version,
        });
        requireValue(lead.ok === true && lead.new_lead === 'joe' &&
          plan.receipts.awaiting_invoice_lead?.new_lead === 'joe');
        const board = await rpc('deal-room-board', { workspace: 'all' });
        const boardDeal = board.deals?.find(row => row.id === dealId);
        requireValue(board.schema_version === 'local-deals-board.v1' && boardDeal?.name === plan.names.awaiting_invoice &&
          boardDeal.phase === 'pending' && boardDeal.owner === 'joe');
        const baseEventId = boardDeal.field_base?.phase?.id ?? null;
        const closed = await write('awaiting_invoice_close', 'patch-deal-field', {
          deal: dealId, field: 'phase', value: 'closed', base_event_id: baseEventId,
          change_reason: 'Explicitly fictional W15 awaiting-invoice staging QA fixture only',
        });
        requireValue(closed.ok === true && closed.deal_id === dealId && closed.field === 'phase' &&
          plan.receipts.awaiting_invoice_close?.deal_id === dealId &&
          plan.receipts.awaiting_invoice_close?.field === 'phase' &&
          isUUID(plan.receipts.awaiting_invoice_close?.event_id || ''));
      } else {
        requireValue(record.name === plan.names.awaiting_invoice &&
          plan.receipts.awaiting_invoice_deal.deal_id === record.deal_id &&
          plan.receipts.awaiting_invoice_deal.name === record.name &&
          plan.receipts.awaiting_invoice_deal.client_ref === plan.records.client.ref &&
          plan.receipts.awaiting_invoice_lead.ok === true && plan.receipts.awaiting_invoice_lead.new_lead === 'joe' &&
          plan.receipts.awaiting_invoice_close.ok === true &&
          plan.receipts.awaiting_invoice_close.deal_id === record.deal_id &&
          plan.receipts.awaiting_invoice_close.field === 'phase' &&
          isUUID(plan.receipts.awaiting_invoice_close.event_id || ''));
      }
    }
    plan.current_step = 'readback';
    await persist(planPath, plan);
    const boundedText = value => typeof value === 'string' && value.length > 0 && value.length <= 500;
    const clientRead = await json(`/api/v1/business/clients/${plan.records.client.id}`);
    requireValue(clientRead.record?.id === plan.records.client.id && boundedText(clientRead.record.name));
    requireValue(existing || clientRead.record.name === plan.records.client.name);
    if (tourDraftFixture) {
      requireValue(plan.records.tour_draft_party && plan.records.tour_draft_client &&
        plan.receipts.tour_draft_party?.party_id === plan.records.tour_draft_party.id &&
        plan.receipts.tour_draft_client?.client_id === plan.records.tour_draft_client.id);
      const draftClientRead = await json(`/api/v1/business/clients/${plan.records.tour_draft_client.id}`);
      const record = draftClientRead.record;
      requireValue(record?.id === plan.records.tour_draft_client.id &&
        record.name === plan.records.tour_draft_client.name && record.city === 'Pensacola' && record.state === 'FL' &&
        record.ref === plan.records.tour_draft_client.ref);
    }
    if (vendorFixture) {
      const vendorRead = await json(`/api/v1/business/vendors/${plan.records.vendor.id}?contract=vendor-directory.v1`);
      requireValue(vendorRead.viewer === 'joe' && vendorRead.record?.id === plan.records.vendor.id &&
        vendorRead.record.name === plan.records.vendor.name &&
        vendorRead.record.recorded_category === 'cpa' && vendorRead.record.recorded_category_label === 'CPA / Financial' &&
        vendorRead.record.recorded_stage === 'prospect_uncontacted' &&
        vendorRead.record.relationship?.recent_entries?.some(row => row.id === plan.records.vendor_entry.id && row.kind === 'note') &&
        vendorRead.record.relationship?.introductions?.some(row => row.id === plan.records.vendor_entry.link_id));
    }
    const dealView = await rpc('get-deal-room', { deal: plan.records.deal.id }, existing ? plan.records.deal.id : undefined);
    const closedDeal = dealView.error === 'not_found';
    const dealRead = closedDeal ? await rpc('read-deal-reconciliation', { deal: plan.records.deal.id }) : dealView;
    if (closedDeal) requireValue(dealRead.id === plan.records.deal.id && dealRead.phase === 'closed');
    else {
      requireValue(dealRead.deal_id === plan.records.deal.id && boundedText(dealRead.name) &&
        (dealRead.owner === null || boundedText(dealRead.owner)) && boundedText(dealRead.phase));
      requireValue(existing || (dealRead.name === plan.records.deal.name && dealRead.owner === 'joe' && dealRead.phase === 'pending'));
    }
    {
      if (plan.party_reuse) requireValue(plan.party_reuse.schema === 'staging-fixture-party-reuse.v1' &&
        plan.party_reuse.party_id === FIXTURE.id && /^[a-f0-9]{64}$/.test(plan.party_reuse.candidate_response_sha256) &&
        clientRead.record.ref === plan.records.client.ref &&
        (existing || clientRead.record.name === FIXTURE.name) &&
        (closedDeal || dealRead.client_ref === plan.records.client.ref &&
          (existing || dealRead.client_name === FIXTURE.name)));
      const network = await json('/api/v1/business/relationships?contract=relationship-network.v1');
      const partyNode = `party:${FIXTURE.id}`, dealNode = `deal:${plan.records.deal.id}`;
      requireValue(network.schema === 'carr-relationship-network.v1' &&
        Number.isFinite(Date.parse(network.observed_at)) && Date.parse(network.valid_until) > Date.now() &&
        Array.isArray(network.nodes) && Array.isArray(network.edges) &&
        network.nodes.filter(node => node.id === partyNode).length === 1 &&
        network.nodes.some(node => node.id === partyNode && node.kind === 'client' &&
          node.record_id === plan.records.client.id && node.name === plan.records.client.name) &&
        network.nodes.some(node => node.id === dealNode && node.record_id === plan.records.deal.id &&
          (existing || node.name === plan.records.deal.name)) &&
        network.edges.some(edge => edge.id === `client-deal:${plan.records.deal.id}` &&
          edge.kind === 'client_deal' && edge.from === partyNode && edge.to === dealNode));
      if (relationshipFixture) {
        const retained = plan.fixture_proofs?.relationship;
        const proof = retained?.proof || await readPrivateJSON(relationshipFixtureProofPath);
        if (retained && (retained.schema !== 'staging-relationship-fixture-binding.v1' || !['pending-readback', 'verified'].includes(retained.state) ||
            retained.proof_content_sha256 !== digest(proof) || retained.verified_target_sha256 !== digest(relationshipFixtureTarget || null)))
          relationshipFailure();
        const fixture = validateRelationshipProof(proof, plan, relationshipFixtureTarget);
        plan.fixture_proofs ||= {};
        plan.fixture_proofs.relationship = { schema: 'staging-relationship-fixture-binding.v1', state: 'pending-readback',
          proof: structuredClone(proof), proof_content_sha256: digest(proof), verified_target_sha256: digest(relationshipFixtureTarget) };
        delete plan.relationship_fixture;
        await persist(planPath, plan);
        const freshNetwork = await json('/api/v1/business/relationships?contract=relationship-network.v1');
        const relationshipEvidence = assertRelationshipFixture(freshNetwork, fixture.candidate);
        if (fixture.installedAt > Date.parse(freshNetwork.observed_at) + 5000 ||
            digest(fixture.projection) !== digest(relationshipProjection(freshNetwork, fixture.candidate, fixture.rows))) relationshipFailure();
        const referredClient = await json(`/api/v1/business/clients/${fixture.referred.client_id}`);
        const referredDeal = await rpc('get-deal-room', { deal: fixture.referred.id });
        const clientRow = fixture.rows.destination_client, partyRow = fixture.rows.destination_party, dealRow = fixture.rows.destination_deal;
        if (referredClient.record?.id !== clientRow.id || referredClient.record.party_id !== partyRow.id ||
            referredClient.record.name !== partyRow.name || referredClient.record.status !== clientRow.status ||
            referredClient.record.city !== partyRow.city || referredDeal.deal_id !== dealRow.id ||
            ['name', 'client_id', 'owner', 'phase', 'lane', 'deal_type'].some(field => referredDeal[field] !== dealRow[field]))
          relationshipFailure();
        plan.records.relationship_referral_deal = structuredClone(fixture.referred);
        plan.relationship_fixture = relationshipEvidence;
        plan.fixture_proofs ||= {};
        plan.fixture_proofs.relationship = { schema: 'staging-relationship-fixture-binding.v1', state: 'verified',
          proof: structuredClone(proof), proof_content_sha256: digest(proof), verified_target_sha256: digest(relationshipFixtureTarget),
          current_readback: { observed_at: new Date().toISOString(), network_response_sha256: digest(freshNetwork),
            client_response_sha256: digest(referredClient), deal_response_sha256: digest(referredDeal) } };
      }
      if (plan.party_reuse) plan.party_reuse = { ...plan.party_reuse, state: 'verified', client_id: plan.records.client.id,
        deal_id: plan.records.deal.id, network_observed_at: network.observed_at,
        network_response_sha256: digest(network), client_response_sha256: digest(clientRead),
        deal_response_sha256: digest(dealRead) };
      await persist(planPath, plan);
    }
    const invoiceRead = await rpc('read-deal-reconciliation', { deal: plan.records.invoice.deal_id });
    requireValue(invoiceRead.id === plan.records.invoice.deal_id && boundedText(invoiceRead.phase));
    const tracker = await rpc('read-invoice-tracker');
    requireValue(Array.isArray(tracker.entries));
    const invoiceVisible = tracker.entries.some(row => row.deal_id === plan.records.invoice.deal_id);
    requireValue(existing || (invoiceRead.phase === 'closed' && invoiceVisible));
    if (awaitingInvoiceFixture) {
      const awaiting = plan.records.awaiting_invoice;
      const exact = tracker.entries.find(row => row.deal_id === awaiting.deal_id);
      const readback = await rpc('read-deal-reconciliation', { deal: awaiting.deal_id });
      requireValue(validInvoiceTracker(tracker) && exact?.name === awaiting.name && exact.phase === 'closed' &&
        exact.owner === 'joe' && exact.invoiced_on === null && exact.commission_id === null &&
        exact.status === null && readback.id === awaiting.deal_id && readback.name === awaiting.name &&
        readback.phase === 'closed' && readback.invoiced_on === null && readback.lane === 'territory');
    }
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
    if (error?.code === 'staging-fixture-rpc-unresolved')
      throw Object.assign(new Error('Staging records setup stopped; partial plan requires reconciliation; no provider payload was logged'),
        { code: error.code });
    if (error?.code === 'staging-fixture-relationship-prerequisite')
      throw Object.assign(new Error('Staging relationship fixture prerequisite unavailable; no relationship seed was attempted'),
        { code: error.code });
    if (SAFE_RECORD_SETUP_CODES.has(error?.code))
      throw Object.assign(new Error('Staging vendor taxonomy prerequisite unavailable; no fixture mutation was attempted'),
        { code: error.code });
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
  'record-commission-receipt': { record: 'commission', field: 'commission_id',
    keys: ['commission_id', 'base_version', 'received_on', 'idempotency_key'], values: ['base_version', 'received_on'] },
};
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const policyFailure = code => { throw Object.assign(new Error('Staging fixture write refused: ' + code), { code, fixturePolicy: true }); };
const journeyContract = id => id === 'W15' ? invoiceJourney : businessJourneys;
const invoiceDay = (observed, offset) => new Date(Date.parse(observed.slice(0, 10)) - offset * 86_400_000).toISOString().slice(0, 10);
function invoiceCommissionId(run) {
  const bytes = createHash('sha1').update(Buffer.from(invoiceJourney.installer.commission_namespace.replaceAll('-', ''), 'hex'))
    .update(invoiceJourney.installer.commission_name_prefix + run).digest().subarray(0, 16);
  bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128;
  const value = bytes.toString('hex');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
function validateInvoiceProof(proof, plan, target) {
  if (!verifiedFixtureTarget(target)) policyFailure('invoice-fixture-target-unverified');
  const deal = plan.records.invoice?.deal_id, client = plan.records.client?.id;
  if (!isUUID(deal) || !isUUID(client) || plan.receipts.invoice_deal?.deal_id !== deal ||
      plan.receipts.client?.client_id !== client || plan.records.party?.id !== FIXTURE.id ||
      plan.records.party?.name !== FIXTURE.name || plan.records.client?.name !== FIXTURE.name ||
      plan.records.invoice?.name !== `Synthetic staging QA ${plan.run} closed deal` ||
      plan.names?.invoice !== plan.records.invoice.name || new Date(plan.observed_at).toISOString() !== plan.observed_at)
    policyFailure('invoice-fixture-creation-receipts-unproved');
  const id = invoiceCommissionId(plan.run), invoiced = invoiceDay(plan.observed_at, 45), due = invoiceDay(plan.observed_at, 15);
  const expected = { schema: invoiceJourney.installer.proof_schema, provenance: { kind: 'raw-sql-fixture' },
    fixture_run: plan.run, source_pair: plan.release, recorded_plan_observed_at: plan.observed_at,
    verified_target: target, tool_source_sha256: invoiceJourney.installer.sha256,
    fixture: { mode: 'aged-invoice', date_offsets_days: { invoiced_on_before_observation: 45, due_on_before_observation: 15 },
      observation_date: plan.observed_at.slice(0,10), party: { id: FIXTURE.id, name: FIXTURE.name },
      deal: { id: deal, name: plan.names.invoice, phase: 'closed', outcome: proof?.fixture?.deal?.outcome,
        owner: contract.session.actor_slug, client_id: client }, commission_id: id, base_version: 1,
      commission_readback: { id, deal_id: deal, gross_amount: '1.00', status: 'invoiced', invoiced_on: invoiced,
        received_on: null, base_version: 1, due_on: due },
      tracker_readback: { deal_id: deal, commission_id: id, gross_amount: '1.00', status: 'invoiced',
        invoiced_on: invoiced, received_on: null, due_on: due } } };
  if (![null, 'won'].includes(expected.fixture.deal.outcome) || digest(proof) !== digest(expected))
    policyFailure('invoice-fixture-proof-unproved');
  return proof.fixture;
}
async function readInvoiceProof(path) {
  let handle;
  try {
    if (typeof path !== 'string' || path.split('/').includes('..')) policyFailure('invoice-fixture-proof-path-unproved');
    path = resolve(path);
    let cursor = parse(path).root;
    for (const part of dirname(path).slice(cursor.length).split('/').filter(Boolean)) {
      cursor = join(cursor, part);
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) && !(info.mode & 0o1000))
        policyFailure('invoice-fixture-proof-path-unproved');
    }
    const parent = await lstat(dirname(path));
    if (parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700) policyFailure('invoice-fixture-proof-path-unproved');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > 65536)
      policyFailure('invoice-fixture-proof-file-unproved');
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size || bytesRead > 65536) policyFailure('invoice-fixture-proof-file-unproved');
    const raw = bytes.subarray(0, bytesRead);
    return { proof: JSON.parse(raw.toString('utf8')), sha256: createHash('sha256').update(raw).digest('hex') };
  } catch { policyFailure('invoice-fixture-proof-unavailable'); }
  finally { await handle?.close(); }
}
function invoiceTrackerRow(payload, fixture, effect) {
  if (!validInvoiceTracker(payload) || payload.actor !== contract.session.actor_slug) return null;
  const rows = payload.entries.filter(row => row.commission_id === fixture.commission_id || row.deal_id === fixture.deal.id);
  const row = rows.length === 1 ? rows[0] : null, initial = fixture.commission_readback;
  return row && row.commission_id === fixture.commission_id && row.deal_id === fixture.deal.id &&
    row.name === fixture.deal.name && row.owner === fixture.deal.owner && row.phase === 'closed' &&
    Number(row.gross_amount) === 1 && row.commission_invoiced_on === initial.invoiced_on &&
    row.due_on === initial.due_on && row.as_of >= fixture.observation_date &&
    row.status === (effect ? 'received' : 'invoiced') && row.base_version === (effect?.base_version ?? 1) &&
    row.received_on === (effect?.received_on ?? null) && (!effect || effect.received_on <= row.as_of) ? row : null;
}

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
  if (name === 'record-commission-receipt' && keys(['id','base_version','received_on']) &&
      receipt.id === primary && args.commission_id === primary && receipt.base_version === args.base_version + 1 &&
      receipt.received_on === args.received_on && isCalendarDate(receipt.received_on))
    effect = { commission_id: receipt.id, base_version: receipt.base_version, received_on: receipt.received_on };
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
    const automatic = plan?.automatic_phase_fixture;
    const automaticBound = ['admitted', 'observed'].includes(automatic?.state) && automatic.deal_id === primary &&
      automatic.event_id === args.event_id && automatic.old_value === 'pending' &&
      automatic.new_value === 'research';
    if (automaticBound && receipt.old_value === automatic.new_value &&
        receipt.new_value === automatic.old_value)
      effect = { field: 'phase', reverted_event_id: receipt.reverted_event_id,
        prior_old_value: automatic.old_value, old_value: receipt.old_value, new_value: receipt.new_value,
        event_id: receipt.event_id, event_recorded_at: receipt.event_recorded_at };
    else if (prior && priorBinding && prior.response?.binding && digest(priorBinding) === digest(prior.response.binding) &&
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
const fixtureWritesNeedingReadback = new Set(['patch-deal-field', 'revert-deal-field', 'add-critical-date', 'record-commission-receipt']);
function journeyObservation(row) {
  const effect = row.response?.binding?.effect;
  if (!effect) return null;
  if (row.operation === 'record-commission-receipt') return { commission_id: effect.commission_id,
    received_on: effect.received_on, status: 'Paid', payment_form_hidden: true, home_attention_removed: true };
  if (row.operation === 'patch-deal-field') return { phase: effect.new_value, event_id: effect.event_id };
  if (row.operation === 'revert-deal-field')
    return { phase: effect.new_value, reverted_event_id: effect.reverted_event_id, badge: 'Undone' };
  if (row.operation === 'add-critical-date')
    return { critical_date_id: effect.critical_date_id, due_on: effect.due_on, source: effect.source };
  return null;
}
function observedJourneyUI(row) {
  const ui = row.journey?.ui;
  if (row.operation === 'record-commission-receipt' &&
      (row.journey?.before_ui?.schema !== 'staging-business-journey-ui.v1' ||
       row.journey.before_ui.observation_sha256 !== digest({ commission_id: row.record_ids?.[0], home_attention_present: true }))) return false;
  return row.journey?.state === 'observed' && ui?.schema === 'staging-business-journey-ui.v1' &&
    ui.observation_sha256 === digest(journeyObservation(row)) &&
    Number.isFinite(Date.parse(ui.observed_at)) && Date.parse(ui.observed_at) >= Date.parse(row.journey.admitted_at) &&
    Date.parse(ui.observed_at) <= Date.now() + 5000;
}
function observedAutomaticUI(row, plan) {
  const observed = row.automatic_phase;
  const effect = row.response?.binding?.effect;
  return observed?.schema === 'staging-w4-automatic-undo.v1' && observed.state === 'observed' &&
    observed.fixture_run === plan.run && digest(observed.release) === digest(plan.release) &&
    observed.event_id === plan.automatic_phase_fixture?.event_id &&
    plan.automatic_phase_fixture?.state === 'observed' &&
    observed.ui?.schema === 'staging-w4-automatic-undo-ui.v1' &&
    observed.ui.observation_sha256 === digest({ event_id: observed.event_id,
      before_badge_visible: true, exact_undo_clicked: true, after_badge_absent: true,
      restored_phase: 'pending', undo_event_id: effect?.event_id }) &&
    Number.isFinite(Date.parse(observed.ui.observed_at)) &&
    Date.parse(observed.ui.observed_at) >= Date.parse(observed.admitted_at) &&
    Date.parse(observed.ui.observed_at) <= Date.now() + 5000;
}
function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function hasPhaseEvent(detail, dealId, eventId, oldValue, newValue, verb) {
  if (detail?.deal_id !== dealId || !Array.isArray(detail.events)) return false;
  const matches = detail.events.filter(event => event?.id === eventId);
  return matches.length === 1 && matches[0].field === 'phase' && matches[0].verb === verb &&
    matches[0].old_value?.phase === oldValue && matches[0].new_value?.phase === newValue;
}

function verifiedReadback(row, detail, plan) {
  const binding = row.response?.binding;
  const effect = binding?.effect;
  if (binding?.operation === 'patch-deal-field') {
    const eventProved = hasPhaseEvent(detail, row.record_ids[0], effect.event_id, effect.old_value, effect.new_value, 'patch-deal-field');
    if (detail?.deal_id !== row.record_ids[0] || !eventProved) return false;
    if (detail.phase === effect.new_value) return true;
    const undo = plan.browser_write_attempts?.find(attempt => attempt.operation === 'revert-deal-field' &&
      attempt.state === 'acknowledged' && attempt.arguments?.event_id === effect.event_id);
    const undoEffect = undo?.response?.binding?.effect;
    return Boolean(undoEffect && detail.phase === undoEffect.new_value &&
      undoEffect.reverted_event_id === effect.event_id &&
      hasPhaseEvent(detail, row.record_ids[0], undoEffect.event_id, undoEffect.old_value, undoEffect.new_value, 'revert-deal-field'));
  }
  if (binding?.operation === 'revert-deal-field')
    return detail?.deal_id === row.record_ids[0] && detail.phase === effect.new_value &&
      hasPhaseEvent(detail, row.record_ids[0], effect.event_id, effect.old_value, effect.new_value, 'revert-deal-field') &&
      hasPhaseEvent(detail, row.record_ids[0], effect.reverted_event_id, effect.prior_old_value, effect.old_value, 'patch-deal-field') &&
      (!row.automatic_phase || detail.events.some(event => event.id === effect.reverted_event_id &&
        event.actor === 'joe-local'));
  if (binding?.operation === 'add-critical-date') {
    if (detail?.deal_id !== row.record_ids[0] || !Array.isArray(detail.critical_dates)) return false;
    const matches = detail.critical_dates.filter(date => date?.id === effect.critical_date_id);
    return matches.length === 1 && matches[0].kind === effect.kind && matches[0].due_on === effect.due_on &&
      matches[0].source === effect.source && matches[0].note === effect.note;
  }
  return true;
}

function requirePlanCoverage(plan, scope) {
  if (!plan || plan.schema !== 'doctorcre-staging-records-plan.v1' || plan.origin !== STAGING_ORIGIN ||
      plan.state !== 'complete' || plan.inflight) policyFailure('fixture-provenance-missing');
  const attempts = scope ? (plan.browser_write_attempts ?? []).filter(row => scope.fingerprints.has(row.fingerprint) || row.journey) : plan.browser_write_attempts ?? [];
  const refusals = scope ? scope.refusals : plan.browser_write_refusals ?? [];
  if (plan.automatic_phase_fixture && (plan.automatic_phase_fixture.state !== 'observed' ||
      (plan.browser_write_attempts || []).filter(row => row.automatic_phase).length !== 1))
    policyFailure('write-coverage-incomplete');
  if (!Array.isArray(attempts) || !Array.isArray(refusals) || refusals.length ||
      attempts.some(row => {
        if (validPreEffectRefusal(row)) return false;
        if (row.state !== 'acknowledged' || row.response?.acknowledged !== true ||
            !Array.isArray(row.record_ids) || !row.record_ids.length || !row.record_ids.every(isUUID)) return true;
        const bound = completeOperationReceipt(row.operation, row.arguments, row.record_ids, row.response.receipt, row.attempted_at, plan);
        const needsReadback = fixtureWritesNeedingReadback.has(row.operation);
        return !bound || !row.response.binding || digest(bound) !== digest(row.response.binding) ||
          needsReadback && !validIndependentReadback(row) || row.journey && !observedJourneyUI(row) ||
          row.automatic_phase && !observedAutomaticUI(row, plan) ||
          row.operation === 'record-commission-receipt' &&
            (plan.fixture_proofs?.invoice?.state !== 'quarantined' ||
             row.journey?.fixture_proof_sha256 !== plan.fixture_proofs.invoice.proof_sha256 ||
             plan.fixture_proofs.invoice.proof_content_sha256 !== digest(plan.fixture_proofs.invoice.proof));
      })) policyFailure('write-coverage-incomplete');
  const presence = plan.browser_presence_leases || [];
  if (!Array.isArray(presence) || presence.length > 2 ||
      new Set(presence.map(row => row.idempotency_key)).size !== presence.length ||
      presence.some(row => {
        const parent = plan.browser_write_attempts?.find(attempt => attempt.fingerprint === row.parent_fingerprint);
        const receipt = row.response?.receipt;
        return row.schema !== 'staging-fixture-presence-lease.v1' || row.state !== 'settled' ||
          !isUUID(row.admission_id) || !isUUID(row.idempotency_key) || row.fixture_run !== plan.run ||
          digest(row.release) !== digest(plan.release) || row.deal !== plan.records.deal?.id || row.field !== 'phase' ||
          parent?.journey?.id !== 'W4' || parent.journey.step !== 'move' ||
          parent.operation !== 'patch-deal-field' || parent.record_ids?.[0] !== row.deal ||
          row.response?.acknowledged !== true || row.response.sha256 !== digest(receipt) ||
          receipt?.ok !== true || receipt.deal_id !== row.deal || receipt.field !== 'phase' ||
          !Number.isFinite(Date.parse(receipt.expires_at));
      })) policyFailure('write-coverage-incomplete');
}

function validIndependentReadback(row) {
  return row.independent_readback?.schema === 'staging-fixture-business-readback.v1' &&
    row.independent_readback.operation === (row.operation === 'record-commission-receipt' ? 'read-invoice-tracker' : 'get-deal-room') &&
    row.independent_readback.record_id === row.record_ids?.[0] &&
    row.independent_readback.matched === true && /^[a-f0-9]{64}$/.test(row.independent_readback.response_sha256 || '') &&
    typeof row.independent_readback.observed_at === 'string' && Number.isFinite(Date.parse(row.independent_readback.observed_at));
}

function manualW4Complete(plan) {
  const rows = (plan.browser_write_attempts || []).filter(row => row.journey?.id === 'W4');
  if (rows.length !== 2 || !['move', 'undo'].every(step => rows.filter(row => row.journey.step === step).length === 1) ||
      rows.some(row => row.journey.schema !== 'staging-business-journey-step.v1' ||
        row.journey.contract_sha256 !== digest(businessJourneys) ||
        row.journey.fixture_run !== plan.run || digest(row.journey.release) !== digest(plan.release) ||
        row.record_ids?.length !== 1 || row.record_ids[0] !== plan.records.deal?.id ||
        !observedJourneyUI(row) || !validIndependentReadback(row))) return false;
  const move = rows.find(row => row.journey.step === 'move');
  const undo = rows.find(row => row.journey.step === 'undo');
  return move.operation === 'patch-deal-field' && undo.operation === 'revert-deal-field' &&
    move.response?.binding?.effect?.old_value === 'pending' &&
    move.response.binding.effect.new_value === 'research' &&
    undo.arguments?.event_id === move.response.binding.effect.event_id &&
    undo.response?.binding?.effect?.new_value === 'pending';
}

export async function readStagingManualW4Fixture(output, release, run) {
  requireSupervisedRun(output, run);
  const plan = await readPrivateJSON(join(output, 'staging-records-plan.json'));
  if (!plan || plan.release?.source_commit !== release?.source_commit ||
      plan.release?.carr_source_commit !== release?.carr_source_commit ||
      release?.carr_source_commit !== contract.producer.source_commit ||
      !isUUID(plan.records?.deal?.id || '') ||
      plan.receipts?.deal?.deal_id !== plan.records.deal.id)
    policyFailure('automatic-event-manual-predecessor-unproved');
  requirePlanCoverage(plan);
  if (!manualW4Complete(plan)) policyFailure('automatic-event-manual-predecessor-unproved');
  return plan;
}

const automaticJournalName = 'w4-local-agent-phase.json';
async function readAutomaticJournal(output) {
  const path = join(output, 'private', automaticJournalName);
  let directory, file;
  try { directory = await lstat(dirname(path)); file = await lstat(path); }
  catch { policyFailure('automatic-event-journal-missing'); }
  if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700 ||
      await realpath(dirname(path)) !== resolve(dirname(path)))
    policyFailure('automatic-event-journal-unsafe');
  if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600)
    policyFailure('automatic-event-journal-unsafe');
  const journal = await readPrivateJSON(path);
  if (!journal) policyFailure('automatic-event-journal-missing');
  return journal;
}

function validAutomaticJournal(journal, plan, runId) {
  const request = journal?.request, receipt = journal?.receipt;
  return journal?.schema === 'staging-w4-local-agent-phase.v1' && journal.state === 'observed' &&
    journal.doc_authorship_qualified === false && journal.run_id === runId &&
    journal.fixture_run === plan.run && digest(journal.source_pair) === digest(plan.release) &&
    journal.deal_id === plan.records.deal?.id && plan.receipts.deal?.deal_id === journal.deal_id &&
    request && Object.keys(request).sort().join() === 'base_event_id,change_reason,deal,field,idempotency_key,value' &&
    isUUID(request.idempotency_key || '') && request.deal === journal.deal_id &&
    request.field === 'phase' && request.value === 'research' &&
    (request.base_event_id === null || isUUID(request.base_event_id || '')) &&
    request.change_reason === LOCAL_AGENT_PHASE_REASON &&
    receipt?.ok === true && receipt.replayed !== true && receipt.deal_id === journal.deal_id &&
    receipt.field === 'phase' && receipt.old_value === 'pending' && receipt.new_value === 'research' &&
    isUUID(receipt.event_id || '') && Number.isFinite(Date.parse(receipt.event_recorded_at)) &&
    Number.isFinite(Date.parse(journal.started_at)) &&
    ['before_sha256','board_sha256','detail_sha256','cause_sha256'].every(key => /^[a-f0-9]{64}$/.test(journal[key] || '')) &&
    Number.isFinite(Date.parse(journal.observed_at));
}

function validAutomaticBinding(binding, journal, plan) {
  return binding?.schema === 'staging-w4-agent-event-binding.v1' &&
    ['admitted', 'observed'].includes(binding.state) &&
    binding.run_id === journal.run_id &&
    binding.fixture_run === plan.run && digest(binding.source_pair) === digest(plan.release) &&
    binding.deal_id === journal.deal_id && binding.event_id === journal.receipt.event_id &&
    binding.old_value === 'pending' && binding.new_value === 'research' &&
    binding.journal_sha256 === digest(journal) &&
    ['board_sha256','detail_sha256','activity_sha256'].every(key =>
      /^[a-f0-9]{64}$/.test(binding[key] || '')) &&
    Number.isFinite(Date.parse(binding.admitted_at)) &&
    (binding.state !== 'observed' ||
      ['undo_board_sha256','undo_detail_sha256'].every(key => /^[a-f0-9]{64}$/.test(binding[key] || '')));
}

function automaticBeforeReads({ board, detail, activity }, fixture, plan) {
  const deal = plan.records.deal.id, event = fixture.event_id;
  const rows = board?.schema_version === 'local-deals-board.v1' && Array.isArray(board.deals)
    ? board.deals.filter(row => row.id === deal) : [];
  const change = rows[0]?.phase_change;
  const history = Array.isArray(detail?.events) ? detail.events.filter(row => row.id === event) : [];
  const entries = activity?.schema_version === 'doc-activity.v1' && Array.isArray(activity.entries)
    ? activity.entries.filter(row => row.id === event) : [];
  return board?.actor === 'joe' && rows.length === 1 && rows[0].name === plan.records.deal.name &&
    rows[0].owner === 'joe' && rows[0].client_ref === plan.records.client?.ref &&
    rows[0].phase === 'research' && change?.automatic === true && change.event_id === event &&
    change.prior_phase === 'pending' && change.phase === 'research' &&
    change.reason === LOCAL_AGENT_PHASE_REASON && Number.isFinite(Date.parse(change.evidence_date)) &&
    detail?.deal_id === deal && detail.phase === 'research' && detail.phase_change?.event_id === event &&
    detail.phase_change.automatic === true &&
    history.length === 1 && history[0].actor === 'joe-local' && history[0].verb === 'patch-deal-field' &&
    history[0].recorded_at === fixture.event_recorded_at &&
    history[0].field === 'phase' && history[0].old_value?.phase === 'pending' &&
    history[0].new_value?.phase === 'research' && entries.length === 1 &&
    entries[0].actor === 'Joe (local)' && entries[0].partner === 'joe' &&
    entries[0].record?.id === deal && entries[0].why === LOCAL_AGENT_PHASE_REASON &&
    entries[0].before === 'pending' && entries[0].after === 'research' &&
    entries[0].undo?.state === 'available' &&
    entries[0].undo?.event_id === event;
}

async function normalAutomaticReads(run, release, deal, since, includeCause) {
  const fresh = await stagingSession(STAGING_ORIGIN, { run });
  if (fresh.release?.source_commit !== release.source_commit ||
      fresh.release?.carr_source_commit !== release.carr_source_commit)
    policyFailure('automatic-event-source-changed');
  const api = await createStagingRequestContext({ baseURL: STAGING_ORIGIN, storageState: fresh.state, run });
  let sequence = 0;
  const headers = { origin: STAGING_ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const rpc = async (name, args) => {
    const response = await api.post('/mcp', { headers, maxRedirects: 0, data: {
      jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } } });
    if (!response.ok()) policyFailure('automatic-event-normal-read-refused');
    const envelope = await response.json();
    if (envelope?.jsonrpc !== '2.0' || envelope.id !== sequence || envelope.error ||
        envelope.result?.isError || envelope.result?.content?.length !== 1 ||
        envelope.result.content[0].type !== 'text') policyFailure('automatic-event-normal-read-refused');
    return JSON.parse(envelope.result.content[0].text);
  };
  try { return { board: await rpc('deal-room-board', { workspace: 'all' }),
    detail: await rpc('get-deal-room', { deal }),
    activity: includeCause ? await rpc('read-doc-activity',
      { partner: 'joe', record_type: 'deal', since, limit: 100 }) : null }; }
  finally { await api.dispose(); }
}

// One test-harness seam, using the existing private setup/receipt store.
// Unsupported global/account/runtime operations remain explicit coverage gaps.
export function stagingFixtureWriteGuard({ output, release, invoiceFixtureTarget,
  run = process.env.E2E_RUN_SUPERVISED === '1' ? requireSupervisedRun(output) : undefined,
  persist = (path, value) => privateJSON(path, value, false, run),
  normalReads = normalAutomaticReads } = {}) {
  invoiceFixtureTarget = invoiceFixtureTarget && structuredClone(invoiceFixtureTarget);
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
    if (plan.automatic_phase_fixture) {
      const journal = await readAutomaticJournal(output);
      if (!validAutomaticJournal(journal, plan, run.snapshot().id) ||
          !validAutomaticBinding(plan.automatic_phase_fixture, journal, plan))
        policyFailure('automatic-event-journal-changed');
    }
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
    if (name === 'record-commission-receipt') {
      const binding = plan.fixture_proofs?.invoice;
      const fixture = validateInvoiceProof(binding?.proof, plan, invoiceFixtureTarget);
      const before = binding?.before_tracker_readback?.row;
      if (binding.state !== 'ready' || !before || binding.proof_content_sha256 !== digest(binding.proof) ||
          args.commission_id !== fixture.commission_id || args.base_version !== before.base_version ||
          !isCalendarDate(args.received_on) || args.received_on < before.commission_invoiced_on || args.received_on > before.as_of ||
          attempts.some(row => row.operation === name && row.record_ids?.includes(args.commission_id)))
        policyFailure('invoice-fixture-readback-or-payment-unproved');
    }
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
    let priorPhasePatch = null, automaticPhase = null;
    if (name === 'revert-deal-field') {
      const prior = attempts.find(row => row.operation === 'patch-deal-field' && row.state === 'acknowledged' &&
        row.response?.receipt?.event_id === args.event_id);
      const priorBinding = prior && completeOperationReceipt('patch-deal-field', prior.arguments,
        prior.record_ids, prior.response?.receipt, prior.attempted_at, plan);
      const automatic = plan.automatic_phase_fixture;
      automaticPhase = automatic?.state === 'admitted' && automatic.event_id === args.event_id &&
        automatic.deal_id === plan.records.deal?.id && !prior ? automatic : null;
      if ((!automaticPhase && (!priorBinding || !prior.response?.binding ||
          digest(priorBinding) !== digest(prior.response.binding))) ||
          attempts.some(row => row.operation === name && row.arguments?.event_id === args.event_id))
        policyFailure('operation-shape-unproved');
      priorPhasePatch = prior;
    }
    if (name === 'add-critical-date' && (args.kind !== 'rent_start' || !isCalendarDate(args.due_on) ||
        !text(args.source) || args.note !== undefined && !text(args.note) ||
        attempts.some(row => row.operation === name && row.record_ids?.includes(args.deal))))
      policyFailure('operation-shape-unproved');
    const id = name === 'record-commission-receipt' ? plan.fixture_proofs.invoice.proof.fixture.commission_id : ['patch-deal-field', 'add-critical-date'].includes(name)
      ? owned(plan, 'deal', args.deal)
      : name === 'revert-deal-field' && automaticPhase
        ? owned(plan, 'deal', automaticPhase.deal_id)
      : name === 'revert-deal-field' && priorPhasePatch
        ? owned(plan, 'deal', priorPhasePatch.arguments?.deal)
        : owned(plan, spec.record, args[spec.field]) ||
          spec.record === 'deal' && owned(plan, 'invoice', args[spec.field]);
    if (!id) policyFailure('record-outside-fixtures');
    const ids = new Set([id]);
    if (name === 'record-commission-receipt') ids.add(plan.records.invoice.deal_id);
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
  const reconcileInvoiceRead = async (response, requestId) => {
    let rpc, payload;
    try { rpc = await response.json(); payload = JSON.parse(rpc.result.content[0].text); } catch { return; }
    if (response.status() !== 200 || rpc.jsonrpc !== '2.0' || rpc.id !== requestId || rpc.error || rpc.result?.isError ||
        rpc.result?.content?.length !== 1 || rpc.result.content[0].type !== 'text') return;
    await locked(async () => {
      const stored = planPath ? await readPrivateJSON(planPath) : null;
      if (!stored?.fixture_proofs?.invoice) return;
      const plan = await currentPlan(), binding = plan.fixture_proofs.invoice;
      if (!binding) return;
      const fixture = validateInvoiceProof(binding.proof, plan, invoiceFixtureTarget);
      if (binding.proof_content_sha256 !== digest(binding.proof) || !validInvoiceTracker(payload) ||
          Date.parse(payload.observed_at) < Date.parse(binding.imported_at) - 5000 ||
          Date.parse(payload.observed_at) > Date.now() + 5000) return;
      const before = invoiceTrackerRow(payload, fixture);
      let measured = null;
      delete binding.current_tracker_readback;
      if (before && binding.state !== 'quarantined') {
        measured = before;
        binding.state = 'ready';
        binding.before_tracker_readback = { operation: 'read-invoice-tracker', response_sha256: digest(rpc),
          observed_at: payload.observed_at, row: structuredClone(before) };
      } else {
        const candidates = payload.entries.filter(row => row.commission_id === fixture.commission_id);
        const current = candidates.length === 1 ? candidates[0] : null;
        const effect = current && { base_version: current.base_version, received_on: current.received_on };
        if (current?.status === 'received' && current.base_version === 2 && isCalendarDate(current.received_on) &&
            current.received_on >= fixture.commission_readback.invoiced_on && invoiceTrackerRow(payload, fixture, effect)) {
          binding.state = 'quarantined';
          measured = current;
        }
        else if (binding.state !== 'quarantined') binding.state = 'unavailable';
      }
      if (measured) binding.current_tracker_readback = { operation: 'read-invoice-tracker', response_sha256: digest(rpc),
        observed_at: payload.observed_at, row: structuredClone(measured) };
      for (const row of plan.browser_write_attempts || []) {
        if (row.operation !== 'record-commission-receipt' || row.state !== 'acknowledged' ||
            row.record_ids?.[0] !== fixture.commission_id || !invoiceTrackerRow(payload, fixture, row.response?.binding?.effect)) continue;
        row.independent_readback = { schema: 'staging-fixture-business-readback.v1', operation: 'read-invoice-tracker',
          record_id: fixture.commission_id, response_sha256: digest(rpc), matched: true, observed_at: new Date().toISOString() };
      }
      await persist(planPath, plan);
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
  const scopedOptions = { currentPlan, persistPlan: plan => persist(planPath, plan), locked, run };
  const invoiceClose = createInvoiceCloseGuard(scopedOptions);
  const companions = createCompanionGuard(scopedOptions);
  const guard = {
    refusals,
    admitInvoiceClose: spec => invoiceClose.admitInvoiceClose(spec),
    companionJourney: spec => companions.companionJourney(spec),
    forContext() {
      const scope = { refusals: [], pending: new Set(), fingerprints: new Set() };
      return {
        refusals: scope.refusals,
        handle: (request, forward) => guard.handle(request, forward, scope),
        assertCoverage: options => guard.assertCoverage(options, scope),
        admitControl: control => guard.admitControl(control, scope),
        admitBusinessJourneyStep: step => guard.admitBusinessJourneyStep(step),
        admitBusinessJourneyPresence: step => guard.admitBusinessJourneyPresence(step),
        admitAutomaticPhaseUndo: step => guard.admitAutomaticPhaseUndo(step),
        admitInvoiceClose: step => guard.admitInvoiceClose(step),
        companionJourney: step => guard.companionJourney(step),
      };
    },
    async admitBusinessJourneyPresence(spec) {
      requireSupervisedRun(output, run);
      run.check();
      const keys = Object.keys(spec || {}).sort().join();
      if (spec?.journey !== 'W4' || spec.step !== 'move' || spec.field !== 'phase' ||
          !['admit', 'settle'].includes(spec.phase) ||
          keys !== (spec.phase === 'admit' ? 'deal,field,journey,phase,release,step'
            : 'admission_id,deal,field,journey,phase,release,step'))
        policyFailure('presence-journey-scope-unproved');
      const deadline = Date.now() + effectiveRunLimits(run).settlementMs;
      while (true) {
        const result = await locked(async () => {
          const plan = await currentPlan(), rows = plan.browser_presence_leases || [];
          const parent = (plan.browser_write_attempts || []).filter(row => row.journey?.id === 'W4' &&
            row.journey.step === 'move' && row.journey.state === 'admitted' && row.state === 'admitted' &&
            row.operation === 'patch-deal-field' && row.record_ids?.[0] === spec.deal &&
            row.journey.fixture_run === plan.run && row.journey.contract_sha256 === digest(journeyContract('W4')));
          if (!owned(plan, 'deal', spec.deal) ||
              spec.release?.source_commit !== plan.release.source_commit ||
              spec.release?.carr_source_commit !== plan.release.carr_source_commit ||
              parent.length !== 1 || !Array.isArray(rows) || rows.length > 2)
            policyFailure('presence-journey-scope-unproved');
          if (spec.phase === 'admit') {
            if (rows.length >= 2 || rows.some(row => row.state !== 'settled'))
              policyFailure('presence-journey-scope-unproved');
            const row = { schema: 'staging-fixture-presence-lease.v1', admission_id: randomUUID(),
              fixture_run: plan.run, release: structuredClone(plan.release), parent_fingerprint: parent[0].fingerprint,
              deal: spec.deal, field: 'phase', state: 'admitted', admitted_at: new Date().toISOString() };
            plan.browser_presence_leases = [...rows, row];
            await persist(planPath, plan);
            return { admission_id: row.admission_id, state: row.state };
          }
          const row = rows.find(row => row.admission_id === spec.admission_id);
          if (!row || row.parent_fingerprint !== parent[0].fingerprint || row.deal !== spec.deal ||
              row.field !== 'phase' || row.fixture_run !== plan.run || digest(row.release) !== digest(plan.release) ||
              row.state === 'unresolved' || row.state === 'settled')
            policyFailure('presence-journey-scope-unproved');
          if (row.state !== 'acknowledged') return null;
          row.state = 'settled';
          row.settled_at = new Date().toISOString();
          await persist(planPath, plan);
          return { admission_id: row.admission_id, state: row.state,
            receipt_sha256: row.response.sha256 };
        });
        if (result) return result;
        if (Date.now() >= deadline) policyFailure('presence-settlement-timeout');
        run.check();
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    },
    async admitAutomaticPhaseUndo(spec) {
      requireSupervisedRun(output, run);
      run.check();
      const keys = Object.keys(spec || {}).sort().join();
      if (!['admit','status','observe'].includes(spec?.phase) ||
          keys !== (spec.phase === 'observe' ? 'deal,observation,phase,release' : 'deal,phase,release') ||
          spec.release?.source_commit !== release?.source_commit ||
          spec.release?.carr_source_commit !== release?.carr_source_commit ||
          !isUUID(spec.deal || '')) policyFailure('automatic-undo-scope-unproved');
      if (spec.phase === 'status') return locked(async () => {
        const plan = await currentPlan();
        if (plan.records.deal?.id !== spec.deal) policyFailure('record-outside-fixtures');
        const rows = (plan.browser_write_attempts || []).filter(row => row.automatic_phase);
        if (rows.length !== 1) policyFailure('automatic-undo-intent-missing');
        return structuredClone(rows[0]);
      });
      await locked(async () => {
        const plan = await currentPlan();
        if (!owned(plan, 'deal', spec.deal)) policyFailure('record-outside-fixtures');
      });
      const journal = await readAutomaticJournal(output);
      if (journal.state !== 'observed' || !Number.isFinite(Date.parse(journal.receipt?.event_recorded_at)))
        policyFailure('automatic-event-journal-unsettled');
      const reads = await normalReads(run, release, spec.deal, journal.receipt.event_recorded_at,
        spec.phase === 'admit');
      return locked(async () => {
        const plan = await currentPlan();
        if (!owned(plan, 'deal', spec.deal)) policyFailure('record-outside-fixtures');
        const attempts = plan.browser_write_attempts || [];
        const rows = attempts.filter(row => row.automatic_phase);
        if (rows.length > 1) policyFailure('automatic-undo-intent-ambiguous');
        if (spec.phase === 'admit') {
          if (rows.length) policyFailure('automatic-undo-intent-already-exists');
          requirePlanCoverage(plan);
          if (!validAutomaticJournal(journal, plan, run.snapshot().id) ||
              journal.deal_id !== spec.deal ||
              attempts.some(row => row.response?.receipt?.event_id === journal.receipt.event_id ||
                row.arguments?.event_id === journal.receipt.event_id) ||
              !automaticBeforeReads(reads, journal.receipt, plan))
            policyFailure('automatic-event-provenance-unproved');
          if (!manualW4Complete(plan) || attempts.some(row => row.journey?.id === 'W4' &&
              row.response?.binding?.effect?.event_id === journal.receipt.event_id))
            policyFailure('automatic-event-manual-predecessor-unproved');
          plan.automatic_phase_fixture = { schema: 'staging-w4-agent-event-binding.v1',
            state: 'admitted', deal_id: spec.deal, event_id: journal.receipt.event_id,
            old_value: 'pending', new_value: 'research', journal_sha256: digest(journal),
            source_pair: structuredClone(plan.release), fixture_run: plan.run, run_id: run.snapshot().id,
            board_sha256: digest(reads.board), detail_sha256: digest(reads.detail),
            activity_sha256: digest(reads.activity), admitted_at: new Date().toISOString() };
          const template = { event_id: journal.receipt.event_id };
          const { ids, fingerprint } = proveOperation(plan, 'revert-deal-field',
            { ...template, idempotency_key: randomUUID() });
          const row = { schema: 'staging-fixture-browser-intent.v1', fingerprint,
            operation: 'revert-deal-field', record_ids: [...ids], argument_template: template,
            arguments: structuredClone(template), state: 'admitted', dispatched_outcome: 'not dispatched',
            automatic_phase: { schema: 'staging-w4-automatic-undo.v1', state: 'admitted',
              event_id: template.event_id, fixture_run: plan.run, release: structuredClone(plan.release),
              admitted_at: new Date().toISOString() } };
          plan.browser_write_attempts ||= [];
          plan.browser_write_attempts.push(row);
          await persist(planPath, plan);
          return structuredClone(row);
        }
        const row = rows[0], event = plan.automatic_phase_fixture?.event_id;
        if (!row || row.state !== 'acknowledged' || row.automatic_phase.state !== 'admitted' ||
            row.arguments?.event_id !== event || !validIndependentReadback(row) ||
            !row.response?.binding?.effect ||
            digest(spec.observation) !== digest({ event_id: event, before_badge_visible: true,
              exact_undo_clicked: true, after_badge_absent: true, restored_phase: 'pending',
              undo_event_id: row.response.binding.effect.event_id }))
          policyFailure('automatic-undo-observation-unproved');
        const boardRows = reads.board?.schema_version === 'local-deals-board.v1' &&
          Array.isArray(reads.board.deals) ? reads.board.deals.filter(item => item.id === spec.deal) : [];
        const change = boardRows[0]?.phase_change, detail = reads.detail;
        const effect = row.response.binding.effect;
        if (reads.board?.actor !== 'joe' || boardRows.length !== 1 ||
            boardRows[0].name !== plan.records.deal.name || boardRows[0].owner !== 'joe' ||
            boardRows[0].client_ref !== plan.records.client?.ref || boardRows[0].phase !== 'pending' ||
            change?.event_id !== effect.event_id || change.automatic !== false ||
            detail?.deal_id !== spec.deal || detail.phase !== 'pending' ||
            detail.phase_change?.event_id !== effect.event_id ||
            !verifiedReadback(row, detail, plan) ||
            detail.events.filter(item => item.id === effect.event_id && item.actor === 'joe').length !== 1)
          policyFailure('automatic-undo-readback-unproved');
        row.automatic_phase.state = 'observed';
        row.automatic_phase.ui = { schema: 'staging-w4-automatic-undo-ui.v1',
          observation_sha256: digest(spec.observation), observed_at: new Date().toISOString() };
        plan.automatic_phase_fixture.state = 'observed';
        plan.automatic_phase_fixture.undo_board_sha256 = digest(reads.board);
        plan.automatic_phase_fixture.undo_detail_sha256 = digest(detail);
        requirePlanCoverage(plan);
        await persist(planPath, plan);
        return structuredClone(row);
      });
    },
    async admitBusinessJourneyStep(spec) {
      requireSupervisedRun(output, run);
      run.check();
      const selectedContract = journeyContract(spec?.journey);
      const invoice = spec?.journey === 'W15';
      if (!spec || Object.keys(spec).some(key => !['phase', 'journey', 'step', 'deal', 'release', 'observation',
          ...(invoice ? ['proofPath','received_on','before_observation'] : [])].includes(key)) ||
          !['admit', 'status', 'observe', ...(invoice ? ['import-fixture','fixture-status','fixture-refresh'] : [])].includes(spec.phase) ||
          selectedContract.full_v1_qualification !== false || selectedContract.producer.source_commit !== contract.producer.source_commit)
        policyFailure('journey-scope-unproved');
      const journey = selectedContract.journeys.find(journey => journey.id === spec.journey);
      const definition = journey?.steps.find(step => step.id === spec.step);
      if (!definition) policyFailure('journey-scope-unproved');
      for (const [path, hash] of Object.entries(selectedContract.sources)) {
        const bytes = await readFile(new URL('../../' + path, import.meta.url));
        if (createHash('sha256').update(bytes).digest('hex') !== hash) policyFailure('journey-source-changed');
      }
      return locked(async () => {
        const plan = await currentPlan();
        if (spec.release?.source_commit !== plan.release.source_commit ||
            spec.release?.carr_source_commit !== plan.release.carr_source_commit)
          policyFailure('journey-source-pair-changed');
        if (!owned(plan, invoice ? 'invoice' : 'deal', spec.deal)) policyFailure('record-outside-fixtures');
        const attempts = plan.browser_write_attempts || [];
        if (invoice && spec.phase === 'import-fixture') {
          requirePlanCoverage(plan);
          const imported = await readInvoiceProof(spec.proofPath);
          validateInvoiceProof(imported.proof, plan, invoiceFixtureTarget);
          const existing = plan.fixture_proofs?.invoice;
          if (existing) {
            if (existing.proof_sha256 !== imported.sha256 || existing.proof_content_sha256 !== digest(imported.proof))
              policyFailure('invoice-fixture-proof-binding-changed');
            return structuredClone(existing);
          }
          plan.fixture_proofs ||= {};
          plan.fixture_proofs.invoice = { schema: 'staging-invoice-fixture-binding.v1', state: 'pending-readback',
            proof: imported.proof, proof_sha256: imported.sha256, proof_content_sha256: digest(imported.proof),
            verified_target_sha256: digest(invoiceFixtureTarget), imported_at: new Date().toISOString() };
          await persist(planPath, plan);
          return structuredClone(plan.fixture_proofs.invoice);
        }
        const fixture = invoice ? validateInvoiceProof(plan.fixture_proofs?.invoice?.proof, plan, invoiceFixtureTarget) : null;
        if (invoice && (plan.fixture_proofs.invoice.proof_content_sha256 !== digest(plan.fixture_proofs.invoice.proof) ||
            plan.fixture_proofs.invoice.verified_target_sha256 !== digest(invoiceFixtureTarget)))
          policyFailure('invoice-fixture-proof-binding-changed');
        if (invoice && spec.phase === 'fixture-status') return structuredClone(plan.fixture_proofs.invoice);
        if (invoice && spec.phase === 'fixture-refresh') {
          const binding = plan.fixture_proofs.invoice;
          delete binding.current_tracker_readback;
          if (binding.state !== 'quarantined') binding.state = 'pending-readback';
          await persist(planPath, plan);
          return structuredClone(binding);
        }
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
        if (invoice) template = { commission_id: fixture.commission_id,
          base_version: plan.fixture_proofs.invoice.before_tracker_readback?.row?.base_version, received_on: spec.received_on };
        if (!template) policyFailure('journey-scope-unproved');
        const matches = attempts.filter(row => row.journey?.id === spec.journey && row.journey?.step === spec.step);
        if (matches.length > 1) policyFailure('journey-step-requires-reconciliation');
        let row = matches[0];
        if (invoice) template = row?.argument_template || { commission_id: fixture.commission_id,
          base_version: plan.fixture_proofs.invoice.before_tracker_readback?.row?.base_version, received_on: spec.received_on };
        if (invoice && spec.phase === 'status' && !row) return null;
        if (row && (row.journey.schema !== 'staging-business-journey-step.v1' ||
            row.journey.contract_sha256 !== digest(selectedContract) || row.journey.fixture_run !== plan.run ||
            digest(row.journey.release) !== digest(plan.release) || digest(row.argument_template) !== digest(template) ||
            row.operation !== definition.operation || row.record_ids?.length !== (invoice ? 2 : 1) ||
            (invoice ? row.record_ids[0] !== fixture.commission_id || row.record_ids[1] !== spec.deal ||
              row.journey.fixture_proof_sha256 !== plan.fixture_proofs.invoice.proof_sha256 : row.record_ids[0] !== spec.deal)))
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
          if (invoice && digest(spec.before_observation) !== digest({ commission_id: fixture.commission_id, home_attention_present: true }))
            policyFailure('invoice-fixture-home-observation-unproved');
          const { ids, fingerprint } = proveOperation(plan, definition.operation, { ...template, idempotency_key: randomUUID() });
          row = { schema: 'staging-fixture-browser-intent.v1', fingerprint, operation: definition.operation,
            record_ids: [...ids], argument_template: template, arguments: structuredClone(template), state: 'admitted',
            dispatched_outcome: 'not dispatched', journey: { schema: 'staging-business-journey-step.v1',
              id: spec.journey, step: spec.step, fixture_run: plan.run, contract_sha256: digest(selectedContract),
              release: structuredClone(plan.release), admitted_at: new Date().toISOString(), state: 'admitted' } };
          if (invoice) Object.assign(row.journey, { fixture_proof_sha256: plan.fixture_proofs.invoice.proof_sha256,
            before_ui: { schema: 'staging-business-journey-ui.v1', observation_sha256: digest(spec.before_observation), observed_at: new Date().toISOString() } });
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
      if (planPath) { await invoiceClose.assertCoverage(); await companions.assertCoverage(); }
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
      let name = 'unknown-operation', token, dispatched = false, admittedRead = false;
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
        const companion = await companions.handle(request, forward);
        if (companion.handled) return companion.response;
        const invoice = await invoiceClose.handle(request, forward);
        if (invoice.handled) return invoice.response;
        const url = new URL(request.url());
        if (url.username || url.password) policyFailure('origin-unproved');
        const read = ['GET', 'HEAD'].includes(request.method());
        if (url.origin !== STAGING_ORIGIN) {
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
          if (name === 'read-invoice-tracker') await reconcileInvoiceRead(response, body.id);
          return response;
        }
        if (!(typeof body.id === 'string' && body.id || Number.isSafeInteger(body.id)))
          policyFailure('operation-shape-unproved');
        if (name === 'presence-lease') {
          token = await locked(async () => {
            const plan = await currentPlan();
            const rows = plan.browser_presence_leases || [];
            const row = rows.find(item => item.state === 'admitted');
            const parent = plan.browser_write_attempts?.find(item => item.fingerprint === row?.parent_fingerprint);
            if (!row || rows.filter(item => item.state === 'admitted').length !== 1 ||
                !parent || parent.state !== 'admitted' || parent.journey?.id !== 'W4' ||
                parent.journey.step !== 'move' || parent.journey.state !== 'admitted' ||
                !owned(plan, 'deal', row.deal) ||
                Object.keys(args).sort().join() !== 'deal,field,idempotency_key' ||
                args.deal !== row.deal || args.field !== 'phase' || !isUUID(args.idempotency_key) ||
                rows.some(item => item.idempotency_key === args.idempotency_key))
              policyFailure('presence-journey-request-unproved');
            row.state = 'inflight';
            row.idempotency_key = args.idempotency_key;
            row.attempted_at = new Date().toISOString();
            await persist(planPath, plan);
            return { run: plan.run, admission_id: row.admission_id };
          });
          if (flight.timedOut) policyFailure('dispatch-settlement-timeout');
          dispatched = true;
          const response = await dispatch();
          await locked(async () => {
            const plan = await currentPlan();
            const row = plan.browser_presence_leases?.find(item => item.admission_id === token.admission_id);
            if (plan.run !== token.run || row?.state !== 'inflight') policyFailure('intent-binding-changed');
            let rpc, receipt;
            try { rpc = await response.json(); } catch {}
            try { receipt = JSON.parse(rpc.result.content[0].text); } catch {}
            const acknowledged = !flight.timedOut && response.status() === 200 &&
              rpc?.jsonrpc === '2.0' && rpc.id === body.id && !rpc.error && !rpc.result?.isError &&
              Array.isArray(rpc.result?.content) && rpc.result.content.length === 1 &&
              rpc.result.content[0].type === 'text' && receipt &&
              Object.keys(receipt).sort().join() === 'deal_id,expires_at,field,ok' &&
              receipt.ok === true && receipt.deal_id === row.deal && receipt.field === 'phase' &&
              typeof receipt.expires_at === 'string' &&
              Number.isFinite(Date.parse(receipt.expires_at)) &&
              Date.parse(receipt.expires_at) >= Date.parse(row.attempted_at) &&
              Date.parse(receipt.expires_at) <= Date.parse(row.attempted_at) + 60_000;
            row.state = acknowledged ? 'acknowledged' : 'unresolved';
            row.response = { acknowledged: Boolean(acknowledged), sha256: digest(receipt ?? null) };
            if (acknowledged) row.response.receipt = structuredClone(receipt);
            await persist(planPath, plan);
            if (!acknowledged) policyFailure('dispatch-outcome-unresolved');
          });
          return response;
        }
        token = await locked(async () => {
          const plan = await currentPlan();
          const admitted = (plan.browser_write_attempts || []).filter(row => row.state === 'admitted' &&
            (row.journey || row.automatic_phase));
          const intent = admitted.length === 1 ? admitted[0] : null;
          if (name === 'record-commission-receipt' && !intent) policyFailure('journey-intent-missing');
          if ((plan.browser_write_attempts || []).some(row => row.journey || row.automatic_phase) && !intent)
            policyFailure('journey-intent-missing');
          const actualTemplate = { ...args };
          delete actualTemplate.idempotency_key;
          if (admitted.length && (!intent || intent.operation !== name ||
              digest(actualTemplate) !== digest(intent.argument_template))) policyFailure('journey-request-unproved');
          if (intent?.journey && (intent.journey.schema !== 'staging-business-journey-step.v1' ||
              intent.journey.state !== 'admitted' || intent.journey.fixture_run !== plan.run ||
              digest(intent.journey.release) !== digest(plan.release) ||
              intent.journey.contract_sha256 !== digest(journeyContract(intent.journey.id))))
            policyFailure('journey-binding-changed');
          if (intent?.automatic_phase && (name !== 'revert-deal-field' ||
              intent.automatic_phase.state !== 'admitted' ||
              intent.automatic_phase.schema !== 'staging-w4-automatic-undo.v1' ||
              intent.automatic_phase.fixture_run !== plan.run ||
              digest(intent.automatic_phase.release) !== digest(plan.release) ||
              intent.automatic_phase.event_id !== plan.automatic_phase_fixture?.event_id ||
              args.event_id !== intent.automatic_phase.event_id))
            policyFailure('automatic-undo-binding-changed');
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
          const refusal = !flight.timedOut && verifiedPreEffectRefusal(name, intent.arguments, rpc, body.id, response.status());
          intent.state = acknowledged ? 'acknowledged' : refusal ? 'refused' : 'unresolved';
          intent.dispatched_outcome = acknowledged ? 'complete operation receipt retained; effect not independently verified'
            : refusal ? 'verified pre-effect refusal' : 'unknown';
          intent.response = { http_status: response.status(), sha256: digest(rpc ?? null), acknowledged };
          if (refusal) Object.assign(intent.response, { refusal, envelope: structuredClone(rpc), request_id: body.id });
          if (bound) {
            intent.response.binding = bound;
            intent.response.receipt = structuredClone(receipt);
          }
          if (flight.timedOut) intent.coverage_timeout = true;
          await persist(planPath, plan);
          if (!acknowledged && !refusal) policyFailure('dispatch-outcome-unresolved');
        });
        return response;
      } catch (error) {
        if (error.companionRead) throw error;
        if (admittedRead && !error.fixturePolicy) throw error;
        const gap = { operation: typeof name === 'string' && (browserReads.has(name) || Object.hasOwn(fixtureWrites, name) || name === 'presence-lease') ? name : 'unknown-operation',
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
  const plan = await readPrivateJSON(join(output, 'staging-records-plan.json'));
  requirePlanCoverage(plan);
  await createInvoiceCloseGuard({ currentPlan: async () => plan }).assertCoverage();
  await createCompanionGuard({ currentPlan: async () => plan }).assertCoverage();
  let journalPresent = false;
  try { await lstat(join(output, 'private', automaticJournalName)); journalPresent = true; }
  catch (error) { if (error.code !== 'ENOENT') policyFailure('automatic-event-journal-unsafe'); }
  if (journalPresent !== Boolean(plan.automatic_phase_fixture))
    policyFailure('automatic-event-reconciliation-required');
  if (plan?.automatic_phase_fixture) {
    const journal = await readAutomaticJournal(output);
    if (!validAutomaticJournal(journal, plan, plan.automatic_phase_fixture.run_id) ||
        !validAutomaticBinding(plan.automatic_phase_fixture, journal, plan))
      policyFailure('automatic-event-journal-changed');
  }
}

export async function readStagingFixtureRelease(output) {
  const setup = await readPrivateJSON(join(output, 'staging-records.json'));
  if (setup?.schema !== 'doctorcre-staging-records.v1' || setup.origin !== STAGING_ORIGIN ||
      setup.complete !== true || !/^[0-9a-f]{40}$/.test(setup.release?.source_commit || '') ||
      setup.release?.carr_source_commit !== contract.producer.source_commit)
    policyFailure('fixture-provenance-missing');
  return setup.release;
}
