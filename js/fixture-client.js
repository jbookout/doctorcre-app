import { compareInstants } from './change-receipts.mjs';
import { businessDay } from './business-date.js';
import { isClosedDeal } from './deal-review-model.js';
import { addDays, localToday } from './calendar-model.js';
import { relationshipNetworkFixture } from './relationship-network-fixture.js';
import { createInvoiceFixture } from './invoice-tracker-fixture.js';
/**
 * Fixture client: full WO-1 contract against in-memory state seeded from
 * data/board-seed.json. Zero network. Live and fixture share one interface.
 */
import { CONNECTION_NAMES } from './connections-model.js';
import { uuidv4 } from './uuid.js';
import { observeDocClient } from './doc-context.js';
import { PHASES } from './client.js';
import { readinessRequest, threadRequest } from './correspondence-model.js';
import {
  MY_FLAGGED_DESTINATION, NEEDS_JOE_DESTINATION, TEAM_ACTIVE_DESTINATION, TEAM_FLAGGED_DESTINATION,
} from './workspace-command-center-model.js';

const LEASE_TTL_MS = 3000;
const IDEM_TTL_MS = 60 * 60 * 1000;
const CORRESPONDENCE_CEILING = {
  dispatchable: false, provider_operation: null, send_authority_holder: 'human_partner_outside_carr',
  send_authority_seam: 'step:v5-representative-workflow-external-send-authority-decision', automatic_internal_update: false,
  effects: { creates_effect: false, database_writes: 0, network_calls: 0, provider_actions: 0,
    notifications: 0, schedules: 0, deployments: 0, activations: 0, acceptances: 0 },
};
const PORTAL_ORIGIN = 'https://share.doctorcre.com';
/** The cells patch-deal-field bases on; mirrors the record layer's DEAL_ROOM_FIELDS. */
const BASED_FIELDS = ['phase', 'owner', 'attention', 'next_date', 'operating_state'];

export function createFixtureDealStore(seed) {
  const events = structuredClone(seed.seed_events || []).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  return {
    deals: new Map(seed.deals.map(d => [d.id, {
      operating_state:'active', parking_reason:null, parking_note:null, parked_at:null, parked_by:null,
      version:1, prospect_engagement_status:'active', client_version:1,
      outcome:null, closed_on:null, won_value:null, phase_started_on:{}, ...structuredClone(d),
    }])),
    threads: new Map(Object.entries(structuredClone(seed.threads || {}))),
    history: new Map(Object.entries(structuredClone(seed.history || {}))),
    events, leases:new Map(), idem:new Map(), conflicts:new Map(), criticalDates:new Map(),
    lastFieldEvent:new Map(events.filter(e => e.field).map(e => [`${e.subject_id}|${e.field}`, e.id])),
    seq:events.length + 1, conflictSeq:1, noteSeq:1, criticalDateSeq:1, histSeq:1,
  };
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.seedUrl]
 * @param {boolean} [opts.emailReplyDrafts] include a synthetic owned reply draft
 * @param {string} [opts.selfActor]
 * @param {ReturnType<typeof createFixtureDealStore>} [opts.dealStore]
 */
const VERSION_CONFLICT = 'version_conflict';

export async function createFixtureClient(opts = {}) {
  let factReview;
  const factReviews = () => factReview ||= import('../data/fixtures/fact-review.mjs').then(module => module.createFactReviewFixture());
  const activityFixture = (await import('./doc-activity-fixture.js')).createDocActivityFixture();
  const seedUrl = opts.seedUrl || new URL('../data/board-seed.json', import.meta.url).href;
  const seed = await fetch(seedUrl).then((r) => {
    if (!r.ok) throw new Error(`fixture seed failed: ${r.status}`);
    return r.json();
  });

  const selfActor = opts.selfActor || seed.actors?.self || 'joe';
  const conventionProposals = [1, 2].map((number) => {
    const section_id = `d0000000-0000-4000-8000-00000000c15${number}`;
    return { section_id, section_key: `conventions/proposed/demo-${number}`, base_version: number,
      updated_at: '2026-10-28T12:00:00Z', adoptable: true, statement: `Demo convention ${number}.`,
      card_id: null, packs: ['demo'], approve_with: { verb: 'adopt-rule', section_id, base_version: number } };
  });
  const conventionReceipts = new Map();

  const partnerActor = seed.actors?.partner || 'dell';

  const dealStore = opts.dealStore || createFixtureDealStore(seed);
  const { deals, threads, history, events, leases, idem, conflicts, criticalDates, lastFieldEvent } = dealStore;
  const fixtureAccountId = 'demo-account-001';
  let fixtureAccountOwner = 'dell';
  let fixtureAccountVersion = 1;
  if (!opts.dealStore) {
    // Demonstrate that Salesforce-shaped records are not automatically active
    // transactions. These are fixture-only examples; production is never
    // changed from a name match.
    for (const id of ['d06', 'd07', 'd08']) {
      const deal = deals.get(id);
      if (deal) Object.assign(deal, { operating_state:'parked', parking_reason:'other',
        parking_note:'No reason given yet', parked_at:'2026-08-10T12:00:00Z', parked_by:'joe' });
    }
    // Keep the local demo representative of the production information model:
    // one national-account portfolio, many market deals, no duplicate deal rows.
    [...deals.values()].slice(0, 5).forEach((d, index) => Object.assign(d, {
      workspace_kind: 'national_account',
      account_client_id: fixtureAccountId,
      account_client_ref: 'DEMO-ACCOUNT-001',
      account_name: 'Demo National Practice',
      account_owner: fixtureAccountOwner,
      client_ref: `DEMO-CLIENT-${String(index + 1).padStart(3, '0')}`,
      client_name: d.name,
      market_agent: index < 3 ? ['Alex Morgan','Taylor Reed','Jordan Lee'][index] : null,
    }));
    [...deals.values()].slice(5).forEach((d) => Object.assign(d, {
      workspace_kind: 'team', account_client_id: null, account_name: null,
      client_ref: d.client_ref || null, client_name: d.client_name || d.name,
    }));
    // d02 names a client id the business-record fixture below deliberately does
    // not carry, so the V5-UX-B04 context drawer's fetch-failure state (test
    // fixture client, not a live network fault) has a fixture deal to exercise.
    const brokenClientDeal = deals.get('d02');
    if (brokenClientDeal) brokenClientDeal.account_client_id = 'demo-account-002-unlisted';
  }


  const extraParticipants = new Map([
    ['d01', [
      { role: 'client_contact', name: 'Dr. Dana Ortiz', party_id: 'demo-party-101' },
      { role: 'referring_agent', name: 'Sam Rivera', party_id: 'demo-party-102' },
      { role: 'listing_side', name: 'Casey Nguyen · Demo Realty', party_id: 'demo-party-103' },
    ]],
  ]);

  // Business records use their own IDs, never participant party_id. d02 is deliberately absent.
  const businessRecords = new Map([
    [fixtureAccountId, {
      id: fixtureAccountId, ref: 'DEMO-CLIENT-001', name: 'Demo Dental North', party_kind: 'org',
      city: 'Demo City', state: 'DM', title: 'Practice Administrator', phone: '205-555-0142', cell: null,
      email: 'admin@demo-dental-north.example', recorded_status: 'active_client',
      recorded_status_label: 'Active client', recorded_status_active_pipeline: true, vertical: 'Dental',
      owner_label: 'Dell', owned_by_viewer: false, record_version: 1,
      created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-10T00:00:00Z',
    }],
  ]);

  // Shared loop display numbers are ambiguous; only record ids identify a loop.
  let loopSeq = 0;
  const loop = (row) => ({
    loop_id: `loop-${String(++loopSeq).padStart(3, '0')}`,
    kind: 'open_loop', domain: 'business', status: 'open', owner: 'joe', marker: 'none',
    body: '', unblocks: null, source_note: 'Demo fixture record', due_on: null,
    blocker_class: null, blocker_detail: null, joint_owner: false,
    close_outcome: null, closed_at: null, version: 1,
    tier: row.kind === 'team_loop' || row.kind === 'action_required' ? 'shared' : 'personal',
    personal_to: row.kind === 'team_loop' || row.kind === 'action_required' ? null : (row.owner || 'joe'),
    since_text: 'open 3 days',
    created_at: '2026-09-13T13:00:00Z', updated_at: '2026-09-15T13:00:00Z',
    ...row,
  });
  /** @type {any[]} */
  const loops = [
    loop({ number: '201', title: 'Demo Gulf Breeze Dental: send the LOI redline to landlord counsel', owner: 'joe', blocker_class: 'human_only', blocker_detail: 'Joe does this personally: send the LOI redline to landlord counsel' }),
    loop({ number: '202', title: 'Demo Navarre Ortho: assemble the information request for the practice CPA', owner: 'joe', marker: 'dated', due_on: '2026-09-15', blocker_class: 'human_only', blocker_detail: 'Joe does this personally: assemble the information request' }),
    loop({ number: '203', title: 'Demo Milton Family Care: refresh the property search', owner: 'dell', marker: 'bell', blocker_class: 'human_only', blocker_detail: 'Dell does this personally: refresh the property search' }),
    loop({ number: '204', title: 'Demo Pace Pediatrics: confirm the survey window', owner: 'dell', blocker_class: 'counterparty', blocker_detail: 'Demo Coastal Surveying has not offered a window since Monday' }),
    loop({ number: '205', title: 'Demo Crestview Derm: read the landlord counter when it lands', owner: 'joe', blocker_class: 'external_event', blocker_detail: 'The landlord counter has not been delivered yet' }),
    loop({ number: '206', title: 'Demo tenant-rep packet: regenerate the market comparison', owner: 'claude', blocker_class: 'capability', blocker_detail: 'The comparison rebuild is queued behind the market refresh' }),
    loop({ kind: 'team_loop', number: '207', title: 'Demo Regional Health Summit: research the exhibitor list and pricing', owner: 'dell', body: 'Research exhibitor list and pricing for the Demo Regional Health Summit' }),
    loop({ kind: 'team_loop', number: '201', title: 'Demo Gulf Breeze Dental: agree the shared close checklist', owner: 'joe', body: 'Agree the shared close checklist with the practice' }),
    loop({ kind: 'team_loop', number: '208', title: 'Demo partnership: reconcile the quarterly referral list', owner: 'joe', joint_owner: true }),
  ];

  const boardRow = (row) => ({
    number: row.number, kind: row.kind, domain: row.domain, status: row.status, owner: row.owner,
    marker: row.marker, title: row.title, label: row.owner === 'claude' ? 'system' : partnerLabel(row.owner),
    joint_owner: row.joint_owner === true, blocker_class: row.blocker_class,
    blocker_detail: row.blocker_detail, since_text: row.since_text, due_on: row.due_on,
    version: row.version,
  });
  const partnerLabel = (owner) => (owner === 'joe' ? 'Joe' : owner === 'dell' ? 'Dell' : String(owner));

  function guardVersion(row, baseVersion) {
    if (baseVersion === undefined || baseVersion === null) {
      const error = new Error('fixture update-loop refused: missing_base_version');
      error.payload = { error: 'missing_base_version', hint: 'Re-read the record and send the version it holds now.' };
      throw error;
    }
    if (Number(baseVersion) !== Number(row.version)) {
      const error = new Error('fixture update-loop refused: version_conflict');
      error.payload = { error: VERSION_CONFLICT, hint: 'The record changed since you read it. Re-open it and decide from what it holds now.' };
      throw error;
    }
  }

  function findLoop({ loop_id, number, kind }) {
    if (loop_id) return loops.find((row) => row.loop_id === loop_id) || null;
    if (!number) return 'need_number_or_id';
    const matches = loops.filter((row) => row.number === String(number) && (!kind || row.kind === kind));
    if (matches.length > 1) return 'ambiguous_number';
    return matches[0] || null;
  }

  /** @type {any[]} confirm proposals from call distill */
  let pendingConfirms = [];
  /** @type {any[]} synthetic read-call-outcomes rows; empty unless a test supplies them */
  const callOutcomes = structuredClone(opts.callOutcomes || []);

  let lastCallAt = seed.last_call_at || '2026-08-07T16:00:00Z';
  let asOf = seed.as_of || '2026-08-08';
  let confirmSeq = 1;
  let reviewSeq = 1;
  const reviewSessions = new Map();

  function nowIso() {
    return new Date().toISOString();
  }

  function nextEventId() {
    return `e-${String(dealStore.seq++).padStart(4, '0')}`;
  }

  function actorLabel(a) {
    if (a === 'joe') return 'Joe';
    if (a === 'dell') return 'Dell';
    return a;
  }

  function ensureThread(dealId) {
    if (!threads.has(dealId)) threads.set(dealId, []);
    return threads.get(dealId);
  }

  function ensureHistory(dealId) {
    if (!history.has(dealId)) history.set(dealId, []);
    return history.get(dealId);
  }

  function pushHistory(dealId, actor, summary, at, kind = 'note') {
    const h = {
      id: `h-${dealStore.histSeq++}`,
      actor,
      summary,
      kind,
      recorded_at: at || nowIso(),
    };
    ensureHistory(dealId).unshift(h);
    return h;
  }

  function pushEvent(partial) {
    const e = {
      id: nextEventId(),
      recorded_at: nowIso(),
      actor: partial.actor || selfActor,
      verb: partial.verb,
      subject_type: partial.subject_type || 'deal',
      subject_id: partial.subject_id,
      field: partial.field ?? null,
      old_value: partial.old_value ?? null,
      new_value: partial.new_value ?? null,
      change_reason: partial.change_reason ?? null,
      automatic: partial.automatic ?? false,
      evidence_date: partial.evidence_date ?? null,
      human_quote: partial.human_quote ?? null,
    };
    events.push(e);
    if (e.field) lastFieldEvent.set(`${e.subject_id}|${e.field}`, e.id);
    return e;
  }

  function phaseChangeFor(id) {
    const e = [...events].reverse().find(e => e.subject_id === id && e.field === 'phase');
    return e ? { event_id:e.id, prior_phase:e.old_value, phase:e.new_value,
      automatic:e.automatic === true && e.verb !== 'revert-deal-field', reason:e.change_reason,
      evidence_date:e.evidence_date, recorded_at:e.recorded_at } : null;
  }

  /**
   * The latest committed event for each editable cell of one deal, as the board
   * read returns it. Built from the same event log the conflict check consults,
   * so what a caller sends back as base_event_id is what this client will compare.
   */
  function fieldBaseFor(dealId) {
    const base = {};
    for (const e of events) {
      if (e.subject_type !== 'deal' || e.subject_id !== dealId || !e.field) continue;
      if (!BASED_FIELDS.includes(e.field)) continue;
      base[e.field] = { id: e.id, recorded_at: e.recorded_at };
    }
    return base;
  }

  function cursorOf(list) {
    if (!list.length) return '0';
    return list[list.length - 1].id;
  }

  function eventsAfter(cursor) {
    if (!cursor || cursor === '0' || cursor === null) return events.slice();
    const idx = events.findIndex((e) => e.id === cursor);
    if (idx < 0) return events.slice(); // unknown cursor: full replay (safe)
    return events.slice(idx + 1);
  }

  function pruneLeases() {
    const t = Date.now();
    for (const [k, v] of leases) {
      if (new Date(v.expires_at).getTime() <= t) leases.delete(k);
    }
  }

  function withIdem(key, fn) {
    if (!key) throw new Error('idempotency_key required');
    const hit = idem.get(key);
    if (hit && Date.now() - hit.at < IDEM_TTL_MS) return structuredClone(hit.result);
    const result = fn();
    idem.set(key, { at: Date.now(), result: structuredClone(result) });
    return result;
  }

  function getDealOrThrow(id) {
    const d = deals.get(id);
    if (!d) throw new Error(`unknown deal ${id}`);
    return d;
  }

  function applyFieldWrite({ deal, field, value, base_event_id, actor, verb, change_reason, human_quote }) {
    const d = getDealOrThrow(deal);
    const key = `${deal}|${field}`;
    const last = lastFieldEvent.get(key) || null;
    const base = base_event_id === undefined ? null : base_event_id;
    if (last !== base) {
      const conflict_id = `c-${dealStore.conflictSeq++}`;
      const payload = {
        conflict_id,
        deal,
        field,
        a: { actor: 'server', value: field === 'attention' ? d.attention : d[field], event_id: last },
        b: { actor, value, event_id: null },
      };
      conflicts.set(conflict_id, { ...payload, pending_value: value, pending_actor: actor, verb });
      return { status: 'conflict', conflict: payload };
    }

    const mapField = field === 'next_step' ? 'next_step' : field;
    const old = field === 'operating_state'
      ? { state:d.operating_state, reason:d.parking_reason, note:d.parking_note }
      : d[mapField];
    if (field === 'attention') d.attention = !!value;
    else if (field === 'owner') d.owner = value || null;
    else if (field === 'phase') {
      if (!PHASES.includes(value)) throw new Error(`bad phase ${value}`);
      d.phase = value;
    } else if (field === 'next_date') d.next_date = value || null;
    else if (field === 'next_step') d.next_step = value || '';
    else if (field === 'operating_state') {
      if (!value || !['active', 'parked'].includes(value.state)) throw new Error('bad operating state');
      if (value.state === 'parked' && !['prospect_never_active', 'client_paused', 'other'].includes(value.reason))
        throw new Error('parking reason required');
      d.operating_state = value.state;
      d.parking_reason = value.state === 'parked' ? value.reason : null;
      d.parking_note = value.state === 'parked' ? String(value.note || '').trim() || null : null;
      d.parked_at = value.state === 'parked' ? nowIso() : null;
      d.parked_by = value.state === 'parked' ? actor : null;
    }
    else throw new Error(`unknown field ${field}`);

    if (field !== 'operating_state') d.last_touch = nowIso().slice(0, 10);
    const e = pushEvent({
      actor,
      verb: verb || 'patch-deal-field',
      subject_id: deal,
      field,
      old_value: old ?? null,
      new_value: value ?? null,
      change_reason: change_reason ?? null,
      human_quote: human_quote ?? null,
    });
    pushHistory(deal, actor, `${field} ${old ?? '(empty)'} to ${value ?? '(empty)'}`, e.recorded_at, 'field_edit');
    return { status: 'ok', event: e, event_id: e.id, event_recorded_at: e.recorded_at };
  }

  const evidenceRef = (ref) => ({ ref, content_digest: 'd'.repeat(64), redaction_class: 'metadata_only' });
  const facet = (state, ref, note) => ({ state, evidence_refs: ref ? [evidenceRef(ref)] : [], note });
  function passport({ work_request, slices, closure_state, closure, stale = false }) {
    return {
      schema_version: 'engineering-passport.v1',
      work_request,
      accepted_plan_revision: { id: `${work_request}-PLAN`, revision: 3, digest: 'a'.repeat(64) },
      plan_digest: 'b'.repeat(64),
      slice_plan: { work_request, slices: [] },
      execution_envelopes: [],
      slices,
      current_receipts: [], current_reviewer_facts: [], receipts: [], reviewer_facts: [], qa_facts: [],
      operator_receipt: { what_changed: [], why: 'synthetic fixture projection', evidence_refs: [], deviations: [], remaining_risk: [], manual_qa_items: [] },
      closure,
      closure_state,
      stale_conflict: stale
        ? { state: 'stale', reason: 'current Work Request or accepted plan no longer matches the registered slice plan' }
        : { state: 'none', reason: null },
      projection_digest: 'c'.repeat(64),
    };
  }
  const slice = (slice_ref, state) => ({ slice_ref, ordinal: 1, dependency_refs: [], state, planned_check_refs: [], deviation_refs: [], manual_qa_required: false, release_requirement: 'none' });
  const unresolved = (note) => facet('unresolved', null, note);
  const workRequests = new Map([
    ['WR-000901', { ref: 'WR-000901', title: 'Demo built, not merged', state: 'ready', version: 4, portfolio_ref: 'PF-DEMO-1',
      passport: passport({ work_request: 'WR-000901', closure_state: 'blocked', slices: [slice('SL-901-1', 'verified_complete')],
        closure: { work: unresolved('one or more planned slices remain unresolved'), proof: unresolved('receipts are executor claims until independently reviewed'), explanation: unresolved('derived from canonical persisted facts'), release: unresolved('release remains closed until closure is complete'), learning: { state: 'unresolved', route: null, evidence_refs: [], note: 'learning remains a proposal/disposition seam' } } }) }],
    ['WR-000902', { ref: 'WR-000902', title: 'Demo merged, not activated', state: 'ready', version: 2, portfolio_ref: 'PF-DEMO-2',
      passport: passport({ work_request: 'WR-000902', closure_state: 'blocked', slices: [slice('SL-902-1', 'verified_complete')],
        closure: { work: facet('complete', 'demo-merge-902', 'all planned slices have a bound receipt and independent pass'), proof: unresolved('receipts are executor claims until independently reviewed'), explanation: unresolved('derived from canonical persisted facts'), release: unresolved('release remains closed until closure is complete'), learning: { state: 'unresolved', route: null, evidence_refs: [], note: 'learning remains a proposal/disposition seam' } } }) }],
    ['WR-000903', { ref: 'WR-000903', title: 'Demo active, consumer unproven', state: 'ready', version: 7, portfolio_ref: null,
      passport: passport({ work_request: 'WR-000903', closure_state: 'complete', slices: [slice('SL-903-1', 'verified_complete')],
        closure: { work: facet('complete', 'demo-merge-903', 'all planned slices have a bound receipt and independent pass'), proof: unresolved('receipts are executor claims until independently reviewed'), explanation: facet('complete', 'demo-explain-903', 'derived from canonical persisted facts'), release: facet('complete', 'demo-release-903', 'all required slices are verified'), learning: { state: 'unresolved', route: null, evidence_refs: [], note: 'learning remains a proposal/disposition seam' } } }) }],
    ['WR-000904', { ref: 'WR-000904', title: 'Demo captured in error', state: 'captured', version: 1, portfolio_ref: null, passport: null }],
    ['WR-000905', { ref: 'WR-000905', title: 'Demo stale plan', state: 'ready', version: 3, portfolio_ref: 'PF-DEMO-1',
      passport: passport({ work_request: 'WR-000905', closure_state: 'complete', stale: true, slices: [slice('SC-901-1', 'verified_complete')],
        closure: { work: facet('complete', 'demo-merge-905', 'all planned slices have a bound receipt and independent pass'), proof: facet('complete', 'demo-proof-905', 'all receipts are independently reviewed'), explanation: facet('complete', 'demo-explain-905', 'derived from canonical persisted facts'), release: facet('complete', 'demo-release-905', 'all required slices are verified'), learning: { state: 'unresolved', route: null, evidence_refs: [], note: 'learning remains a proposal/disposition seam' } } }) }],
  ]);
  const portfolios = new Map([
    ['PF-DEMO-1', { portfolio_ref: 'PF-DEMO-1', exists: true, accepted: true, accepted_revision_id: 'PF-DEMO-1-R2', reviews: [{ verdict: 'pass', reviewed_digest: 'e'.repeat(64), reviewer_actor_id: partnerActor }] }],
    ['PF-DEMO-2', { portfolio_ref: 'PF-DEMO-2', exists: true, accepted: false, accepted_revision_id: null, reviews: [] }],
  ]);
  /** `deal_outcome_check`, spelled the way the database spells it. */
  const DEAL_OUTCOMES = ['won', 'lost', 'paused'];
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  function refuse(verb, code, extra = {}) {
    const error = new Error(`fixture ${verb} refused: ${code}`);
    error.payload = { error: code, ...extra };
    throw error;
  }
  function workRequestOrRefuse(verb, ref) {
    const row = workRequests.get(String(ref));
    if (!row) refuse(verb, 'work_request_not_found', { work_request: ref });
    return row;
  }
  function guardWorkRequestVersion(verb, row, baseVersion) {
    if (!Number.isInteger(baseVersion)) refuse(verb, 'missing_base_version', { hint: 'Re-read the Work Request card and send the version it holds now.' });
    if (Number(baseVersion) !== Number(row.version)) {
      refuse(verb, VERSION_CONFLICT, { human_ref: row.ref, resolution: 're-read the Work Request card; only its current captured version may be withdrawn' });
    }
  }


  const SESSION_WITH_DISPATCH = "55555555-5555-4555-8555-555555555555";

  const DISPATCH_WITH_EVENTS = {
      "ok": true,
      "session_id": "55555555-5555-4555-8555-555555555555",
      "parent_session_id": "11111111-1111-4111-8111-111111111111",
      "permission_filtered": false,
      "total_seen": 4,
      "total_returned": 4,
      "more": true,
      "next_cursor": "synthetic-cursor-2",
      "received": "2026-09-18T12:02:00+00:00",
      "acknowledged": "2026-09-18T12:03:00+00:00",
      "stage_unavailable_reason": null,
      "events": [
          {
              "event_id": "ev-2",
              "at": "2026-09-18T12:05:00+00:00",
              "stage": "acted",
              "stage_evidence": "a room turn recorded the seat acting on the dispatch",
              "rationale": "the builder seat took the slice",
              "from_seat": "orchestrator",
              "to_seat": "builder",
              "sponsor": "joe",
              "room_id": "model-room",
              "session_id": "55555555-5555-4555-8555-555555555555",
              "parent_session_id": "11111111-1111-4111-8111-111111111111",
              "attempt_ref": "WR-000117#3",
              "superseded_by": null,
              "work_request_ref": "WR-000117",
              "link_source": null,
              "dispatch_ref": null,
              "stage_unavailable_reason": null
          },
          {
              "event_id": "ack-2",
              "at": "2026-09-18T12:03:00+00:00",
              "stage": "acknowledged",
              "stage_evidence": "public.room_dispatch_ack id 12 for dispatch_ref 99999999-9999-4999-8999-999999999999",
              "rationale": "the builder accepted the bounded assignment",
              "from_seat": "orchestrator",
              "to_seat": "builder",
              "sponsor": "joe",
              "room_id": "model-room",
              "session_id": "55555555-5555-4555-8555-555555555555",
              "parent_session_id": "11111111-1111-4111-8111-111111111111",
              "attempt_ref": "WR-000117#3",
              "superseded_by": null,
              "work_request_ref": "WR-000117",
              "link_source": "proved",
              "dispatch_ref": "99999999-9999-4999-8999-999999999999",
              "stage_unavailable_reason": null
          },
          {
              "event_id": "ack-1",
              "at": "2026-09-18T12:02:00+00:00",
              "stage": "received",
              "stage_evidence": "public.room_dispatch_ack id 11 for dispatch_ref 99999999-9999-4999-8999-999999999999",
              "rationale": "the builder desk received the assignment",
              "from_seat": "orchestrator",
              "to_seat": "builder",
              "sponsor": "joe",
              "room_id": "model-room",
              "session_id": "55555555-5555-4555-8555-555555555555",
              "parent_session_id": "11111111-1111-4111-8111-111111111111",
              "attempt_ref": "WR-000117#3",
              "superseded_by": null,
              "work_request_ref": "WR-000117",
              "link_source": "proved",
              "dispatch_ref": "99999999-9999-4999-8999-999999999999",
              "stage_unavailable_reason": null
          },
          {
              "event_id": "ev-1",
              "at": "2026-09-18T12:00:00+00:00",
              "stage": "sent",
              "stage_evidence": "a room turn recorded the dispatch leaving the orchestrator",
              "rationale": null,
              "from_seat": "orchestrator",
              "to_seat": null,
              "sponsor": null,
              "room_id": null,
              "session_id": "55555555-5555-4555-8555-555555555555",
              "parent_session_id": null,
              "attempt_ref": null,
              "superseded_by": "ev-2",
              "work_request_ref": "WR-000117",
              "link_source": "proved",
              "dispatch_ref": "99999999-9999-4999-8999-999999999999",
              "stage_unavailable_reason": null
          }
      ]
  };

  /**
   * An empty answer. Production cannot distinguish an unknown id from a real
   * session with no visible dispatch events, so the UI never makes that claim.
   */
  const dispatchNoSpine = (sessionId) => ({
    ok: true,
    session_id: sessionId,
    parent_session_id: null,
    permission_filtered: false,
    total_seen: 0,
    total_returned: 0,
    more: false,
    next_cursor: null,
    received: null,
    acknowledged: null,
    stage_unavailable_reason: null,
    events: [],
  });

  const OUTCOME_CARD_ROWS = [
    {
      card_id: "card:doc-outcome:1", requested_outcome: "Confirm the LOI redline is ready for Joe's review",
      intent_kind: "recommendation", work_request_ref: "WR-000140", owner: "joe", controlled_phase: "in_progress",
      source_freshness: { state: "fresh", observed_at: "2026-09-23T15:00:00+00:00", source_ref: "work-request:WR-000140" },
      routing_state: "active", state_evidence: { observed_at: "2026-09-23T15:00:00+00:00", routing_source: "canonical_work_request" },
      job_id: { value: "job:1001", unavailable_reason: null },
      attempt_id: { value: "job-attempt:1001-1", unavailable_reason: null },
      canonical_session_id: { value: "66666666-6666-4666-8666-666666666666", unavailable_reason: null },
      native_task_id: { value: null, unavailable_reason: "no_authoritative_native_task_join" },
      next_check: { available: true, value: "2026-09-25T17:00:00+00:00", unavailable_reason: null },
      result: { available: false, value: null, unavailable_reason: "no_accepted_outcome" },
      session_entry: {
        available: false, target: null, capability: null,
        unavailable_reason: "host_available_but_native_task_unbound",
        fallback: { kind: "copy_session_id", value: "66666666-6666-4666-8666-666666666666" },
        auto_launch: false,
      },
    },
    {
      card_id: "card:doc-outcome:2", requested_outcome: "Submit the survey window follow-up",
      intent_kind: "submission", work_request_ref: "WR-000141", owner: "dell", controlled_phase: "claimed",
      source_freshness: { state: "fresh", observed_at: "2026-09-23T14:40:00+00:00", source_ref: "work-request:WR-000141" },
      routing_state: "queued", state_evidence: { observed_at: "2026-09-23T14:40:00+00:00", routing_source: "canonical_work_request" },
      job_id: { value: "job:1002", unavailable_reason: null },
      attempt_id: { value: null, unavailable_reason: "no_authoritative_attempt_join" },
      canonical_session_id: { value: null, unavailable_reason: null },
      native_task_id: { value: null, unavailable_reason: "no_authoritative_native_task_join" },
      next_check: { available: false, value: null, unavailable_reason: "no_proved_next_check" },
      result: { available: false, value: null, unavailable_reason: "no_accepted_outcome" },
      session_entry: {
        available: false, target: null, capability: null,
        unavailable_reason: "session_relation_unavailable", fallback: null, auto_launch: false,
      },
    },
    {
      card_id: "card:doc-outcome:3", requested_outcome: "Review the demo update",
      intent_kind: "submission", work_request_ref: "WR-000142", owner: "joe", controlled_phase: "confirmed_closed",
      source_freshness: { state: "stale", observed_at: "2026-09-20T09:00:00+00:00", source_ref: "work-request:WR-000142" },
      routing_state: "verified", state_evidence: { observed_at: "2026-09-20T09:00:00+00:00", routing_source: "canonical_work_request" },
      job_id: { value: "job:1003", unavailable_reason: null },
      attempt_id: { value: "job-attempt:1003-2", unavailable_reason: null },
      canonical_session_id: { value: "77777777-7777-4777-8777-777777777777", unavailable_reason: null },
      native_task_id: { value: null, unavailable_reason: "no_authoritative_native_task_join" },
      next_check: { available: false, value: null, unavailable_reason: "no_proved_next_check" },
      result: { available: true, value: "Receipt reconciled; migration record closed", unavailable_reason: null },
      session_entry: {
        available: false, target: null, capability: null,
        unavailable_reason: "host_unavailable",
        fallback: { kind: "copy_session_id", value: "77777777-7777-4777-8777-777777777777" },
        auto_launch: false,
      },
    },
    {
      card_id: "card:doc-outcome:4", requested_outcome: "Draft the vendor merge proposal",
      intent_kind: "recommendation", work_request_ref: "WR-000143", owner: null, controlled_phase: "blocked",
      source_freshness: { state: "stale", observed_at: "2026-09-18T09:00:00+00:00", source_ref: "work-request:WR-000143" },
      routing_state: "failed", state_evidence: { observed_at: "2026-09-18T09:00:00+00:00", routing_source: "canonical_work_request" },
      job_id: { value: "job:1004", unavailable_reason: null },
      attempt_id: { value: "job-attempt:1004-1", unavailable_reason: null },
      canonical_session_id: { value: null, unavailable_reason: null },
      native_task_id: { value: null, unavailable_reason: "no_authoritative_native_task_join" },
      next_check: { available: false, value: null, unavailable_reason: "no_proved_next_check" },
      result: { available: false, value: null, unavailable_reason: "no_accepted_outcome" },
      session_entry: {
        available: false, target: null, capability: null,
        unavailable_reason: "session_relation_unavailable", fallback: null, auto_launch: false,
      },
    },
  ];

  // C12 mirrors four queue events and five room turns, including null source_seq and JSON STATUS bodies.
  const QUEUE_EVENTS = [
    { v: 1, board: 'carr-build', event_id: 1302, event: 'created', task_id: 't_185f2c38',
      card: { title: 'Fresh independent review of PR 832 exact corrected head', target: 'deepseek',
        effective_model: 'DeepSeek', status: 'ready', priority: 'P1', cap: 'read',
        updated_at: '2026-09-01T04:08:15Z', source_seq: 9166 },
      summary: 'Fresh independent review of PR 832 exact corrected head created.',
      projected_at: '2026-09-01T04:08:15Z' },
    { v: 1, board: 'carr-build', event_id: 1301, event: 'blocked', task_id: 't_4f0bead4',
      card: { title: 'Repair cross-surface context handoff enforcement', target: 'claude',
        effective_model: 'claude', status: 'blocked', priority: 'P1', cap: 'repo-write',
        updated_at: '2026-09-01T02:09:54Z', source_seq: 9001 },
      summary: 'Repair cross-surface context handoff enforcement is blocked.',
      projected_at: '2026-09-01T02:09:54Z' },
    { v: 1, board: 'carr-build', event_id: 1297, event: 'review_requested', task_id: 't_a80efc8b',
      card: { title: 'Fresh independent Opus 5 High review', target: 'claude-desktop',
        effective_model: { id: 'claude-opus-5-high', host: 'desktop' }, status: 'review',
        priority: 'P2', cap: 'read', updated_at: '2026-08-31T22:41:10Z', source_seq: 8529 },
      summary: 'Fresh independent Opus 5 High review is awaiting review.',
      projected_at: '2026-08-31T22:41:10Z' },
    { v: 1, board: 'carr-build', event_id: 1290, event: 'blocked', task_id: 't_3ca30a9e',
      card: { title: 'Reconcile the production source of truth', target: 'claude-desktop',
        effective_model: 'Claude Opus 5 High (background to Desktop)', status: 'blocked',
        priority: 'P1', cap: 'read', updated_at: '2026-08-30T18:02:00Z', source_seq: null },
      summary: 'Reconcile the production source of truth is blocked.',
      projected_at: '2026-08-30T18:02:00Z' },
  ];

  const ROOM_TURNS = [
    { seq: '6446', room_id: 'model-room', at: '2026-08-28T13:48:34.449372+00:00', sponsor: 'joe',
      seat: 'sol', kind: 'system', msg_id: 'm-6446', origin_channel: 'mcp', origin_actor: 'codex',
      body: '{"event":"STATUS","task_id":"A01","exact_revision":"local-main:eb00add0"}' },
    { seq: '6461', room_id: 'model-room', at: '2026-08-29T09:12:01.000000+00:00', sponsor: 'joe',
      seat: 'sol', kind: 'system', msg_id: 'm-6461', origin_channel: 'mcp', origin_actor: 'joe-local',
      body: 'The reconciliation packet is registered and waiting on review.' },
    { seq: '6467', room_id: 'model-room', at: '2026-08-30T11:40:22.000000+00:00', sponsor: 'joe',
      seat: 'hermes', kind: 'turn', msg_id: 'm-6467', origin_channel: 'mcp', origin_actor: 'joe-local',
      body: 'Routing the review to the seat that already holds the branch.' },
    { seq: '6468', room_id: 'model-room', at: '2026-08-30T11:55:09.000000+00:00', sponsor: 'joe',
      seat: 'sol', kind: 'system', msg_id: 'm-6468', origin_channel: 'mcp', origin_actor: 'joe-local',
      body: 'Acknowledged in prose only; no acknowledgement column exists behind this.' },
    { seq: '6475', room_id: 'model-room', at: '2026-09-01T04:08:19.914333+00:00', sponsor: 'joe',
      seat: 'sol', kind: 'system', msg_id: 'm-6475', origin_channel: 'mcp', origin_actor: 'joe-local',
      body: 'The queue projection was last written here.' },
  ];

  const outage = opts.outage || null;
  const refuseIfOutage = (read, verb) => {
    if (outage !== read) return;
    const error = new Error(`fixture outage: ${verb} is unreachable`);
    error.status = 503;
    throw error;
  };
  const incident = (row) => ({
    ref: row.ref, title: row.title, severity: row.severity, state: row.state,
    environment: 'staging', owner_actor: row.owner_actor, next_action: row.next_action,
    business_impact: row.business_impact, fingerprint: row.fingerprint,
    detected_at: row.detected_at, observed_at: row.detected_at, monitoring_until: null,
    duplicate_of: null, monitoring_window_open: false, age_days: row.age_days,
    occurrences: row.occurrences, occurrence_evidence_status: 'complete',
    legacy_overlap_unknown: false, unresolved_occurrence_edge_count: 0,
    ready_to_close: row.ready_to_close, blocked_by: row.blocked_by || null,
  });
  const incidents = [
    incident({ ref: 'INC-20260915-01', title: 'Demo export service stopped writing its nightly generation', severity: 'SEV-1', state: 'investigating', owner_actor: 'joe', next_action: 'Read the demo export log and name the failing generation', business_impact: 'The demo nightly export is not being produced', fingerprint: 'demo-exporter|production|nightly-export|timeout', detected_at: '2026-09-13T04:10:00.000Z', age_days: 4, occurrences: 6, ready_to_close: false, blocked_by: 'no recovery evidence — supply one, or adjudicate it as a duplicate' }),
    incident({ ref: 'INC-20260916-02', title: 'Demo search read is answering slowly under the demo load', severity: 'SEV-2', state: 'mitigating', owner_actor: 'dell', next_action: 'Hold the demo cache warm until the read settles', business_impact: 'Demo search answers late', fingerprint: 'demo-worker|production|search-read|slow_response', detected_at: '2026-09-15T11:25:00.000Z', age_days: 2, occurrences: 28, ready_to_close: false, blocked_by: 'no recovery evidence — supply one, or adjudicate it as a duplicate' }),
    incident({ ref: 'INC-20260916-03', title: 'Demo staging deploy retried once and then succeeded', severity: 'SEV-3', state: 'monitoring', owner_actor: 'joe', next_action: 'Close it once the demo monitoring window has elapsed', business_impact: 'None observed after the retry', fingerprint: 'demo-worker|staging|deploy|transient_error', detected_at: '2026-09-16T09:40:00.000Z', age_days: 1, occurrences: 1, ready_to_close: true, blocked_by: null }),
  ];
  // B12a mirrors producer severity, delivery and relative-link fields; acknowledgement changes only read_at.
  const notifications = (seed.notifications || []).map((row) => ({
    ...row, delivery: (row.delivery || []).map((entry) => ({ ...entry })),
  }));
  const clampLimit = (value) => {
    if (!Number.isInteger(value)) return 50;
    return Math.min(200, Math.max(1, value));
  };

  // 0527 defaults preserve the unsaved state. Quiet hours wrap midnight; unknown IANA zones are refused.
  const preference = {
    exists: seed.notification_preference?.exists === true,
    device_opt_in: seed.notification_preference?.device_opt_in === true,
    quiet_hours_start: seed.notification_preference?.quiet_hours_start ?? null,
    quiet_hours_end: seed.notification_preference?.quiet_hours_end ?? null,
    timezone: seed.notification_preference?.timezone || 'UTC',
    version: Number.isInteger(seed.notification_preference?.version) ? seed.notification_preference.version : 1,
  };
  const PREF_CLOCK = /^([01][0-9]|2[0-3]):([0-5][0-9])(?::[0-5][0-9])?$/;
  const knownTimezone = (name) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: String(name) });
      return true;
    } catch { return false; }
  };
  const localClock = (timezone) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const hour = parts.find((part) => part.type === 'hour')?.value || '00';
    const minute = parts.find((part) => part.type === 'minute')?.value || '00';
    return `${hour === '24' ? '00' : hour}:${minute}`;
  };
  function quietNow() {
    if (!preference.quiet_hours_start || !preference.quiet_hours_end) return false;
    const start = String(preference.quiet_hours_start).slice(0, 5);
    const end = String(preference.quiet_hours_end).slice(0, 5);
    const now = localClock(knownTimezone(preference.timezone) ? preference.timezone : 'UTC');
    return start <= end ? (now >= start && now < end) : (now >= start || now < end);
  }
  const preferencePayload = () => ({
    ok: true,
    exists: preference.exists,
    device_opt_in: preference.device_opt_in === true,
    quiet_hours_start: preference.quiet_hours_start ?? null,
    quiet_hours_end: preference.quiet_hours_end ?? null,
    timezone: preference.timezone || 'UTC',
    version: preference.version,
  });

  // C14 keeps facts with source/time separate from hypotheses and the other get-incident lists.
  const incidentDetails = new Map([
    ['INC-20260915-01', {
      facts: [
        { statement: 'The demo export writer exited before the nightly generation was written', source: 'demo export log', observed_at: '2026-09-13T04:10:00.000Z' },
        { statement: 'No demo generation row exists for the 13th', source: 'demo generation ledger', observed_at: '2026-09-13T05:02:00.000Z' },
      ],
      hypotheses: [
        { statement: 'The demo writer lost its lease when the demo host restarted', status: 'under investigation', recorded_at: '2026-09-13T06:15:00.000Z' },
      ],
      occurrences: [
        { observed_at: '2026-09-13T04:10:00.000Z', note: 'First demo failure recorded' },
        { observed_at: '2026-09-16T04:11:00.000Z', note: 'Demo failure repeated on the nightly run' },
      ],
      links: [{ kind: 'work_request', ref: 'WR-000901', label: 'Demo bounded request: reconcile the demo vendor rows' }],
      services: [{ key: 'demo-exporter', name: 'Demo exporter', criticality: 'high' }],
      trace: [
        { correlation_id: 'demo-correlation-01', kind: 'deployment', ref: 'DEP-demo-901', state: 'succeeded', environment: 'production', service_key: 'demo-exporter', failure_class: null, detail: 'Demo deploy that shipped the export writer', source_kind: 'deployment', source_ref: 'ops.deployment', freshness_state: 'fresh', occurred_at: '2026-09-12T22:00:00.000Z' },
        { correlation_id: 'demo-correlation-01', kind: 'run', ref: 'RUN-demo-9001', state: 'failed', environment: 'production', service_key: 'demo-exporter', failure_class: 'timeout', detail: 'Demo nightly export run exited before writing its generation', source_kind: 'run', source_ref: 'ops.run', freshness_state: 'fresh', occurred_at: '2026-09-13T04:10:00.000Z' },
        { correlation_id: 'demo-correlation-01', kind: 'work_request', ref: 'WR-000901', state: 'captured', environment: 'production', service_key: null, failure_class: null, detail: 'Demo bounded request opened from the failed run', source_kind: 'work_request', source_ref: 'ops.work_request', freshness_state: 'fresh', occurred_at: '2026-09-13T04:30:00.000Z' },
      ],
    }],
    ['INC-20260916-02', {
      facts: [
        { statement: 'The demo search read answered above its demo budget on every sample', source: 'demo read sampler', observed_at: '2026-09-15T11:25:00.000Z' },
      ],
      hypotheses: [
        { statement: 'The demo cache is cold after the demo deploy', status: 'likely', recorded_at: '2026-09-15T12:00:00.000Z' },
        { statement: 'A demo index is missing on the demo search path', status: 'not assessed', recorded_at: '2026-09-15T12:05:00.000Z' },
      ],
      occurrences: [{ observed_at: '2026-09-15T11:25:00.000Z', note: 'Demo slow read observed under demo load' }],
      links: [{ kind: 'run', ref: 'RUN-demo-0042', label: 'Demo load run 0042' }],
      services: [{ key: 'demo-worker', name: 'Demo worker', criticality: 'critical' }],
      trace: [
        { correlation_id: 'demo-correlation-02', kind: 'check', ref: 'CHK-demo-42', state: 'degraded', environment: 'production', service_key: 'demo-worker', failure_class: 'slow_response', detail: 'Demo search read check crossed the demo budget', source_kind: 'check', source_ref: 'ops.check', freshness_state: 'fresh', occurred_at: '2026-09-15T11:25:00.000Z' },
      ],
    }],
    ['INC-20260916-03', {
      facts: [
        { statement: 'The demo staging deploy failed once and the retry succeeded', source: 'demo deploy log', observed_at: '2026-09-16T09:40:00.000Z' },
      ],
      hypotheses: [
        { statement: 'A transient demo provider error caused the first attempt to fail', status: 'probable', recorded_at: '2026-09-16T09:55:00.000Z' },
      ],
      occurrences: [{ observed_at: '2026-09-16T09:40:00.000Z', note: 'Demo deploy retried once' }],
      links: [],
      services: [{ key: 'demo-worker', name: 'Demo worker', criticality: 'critical' }],
      trace: [
        { correlation_id: 'demo-correlation-03', kind: 'deployment', ref: 'DEP-demo-902', state: 'failed', environment: 'staging', service_key: 'demo-worker', failure_class: 'transient_error', detail: 'Demo staging deploy failed once', source_kind: 'deployment', source_ref: 'ops.deployment', freshness_state: 'fresh', occurred_at: '2026-09-16T09:40:00.000Z' },
        { correlation_id: 'demo-correlation-03', kind: 'deployment', ref: 'DEP-demo-903', state: 'succeeded', environment: 'staging', service_key: 'demo-worker', failure_class: null, detail: 'Demo staging deploy retried and succeeded', source_kind: 'deployment', source_ref: 'ops.deployment', freshness_state: 'fresh', occurred_at: '2026-09-16T09:42:00.000Z' },
      ],
    }],
  ]);

  // V5-UX-B07 hides absent, invalid and unauthorized ids behind the same not-found answer.
  // Creator-only refusal stays distinct. Visibility counts actor-owned and unrevoked grants; titles are synthetic.
  const DOC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const DOC_ACTORS = [seed.actors?.self || 'joe', partnerActor];
  const docTurn = (sequence, role, body, at) => ({
    sequence, role, body, msg_id: `demo-msg-${String(sequence).padStart(2, '0')}`,
    origin_channel: 'app', origin_actor: role === 'assistant' ? 'doc' : 'joe', at,
  });
  const docConversation = (row) => ({
    id: row.id, title: row.title, pinned_at: row.pinned_at || null,
    archived_at: row.archived_at || null, version: row.version, created_by: row.created_by,
    // Visibility is stored independently of grants. Shared creation has zero grants (0523:75-78).
    visibility: row.visibility === 'shared' ? 'shared' : 'private',
    turns: row.turns, grants: row.grants || [],
  });
  const DOC_PRIVATE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01';
  const DOC_SHARED = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c02';
  const DOC_REVOKED = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c03';
  const DOC_SHARED_NO_GRANT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c04';
  const docConversations = new Map([
    [DOC_PRIVATE, docConversation({
      id: DOC_PRIVATE, title: 'Demo — Gulf Breeze LOI and the survey window', version: 3, created_by: 'joe',
      visibility: 'private',
      turns: [
        docTurn(0, 'human', 'Demo: what is still open on the Gulf Breeze letter of intent?', '2026-09-10T13:05:00.000Z'),
        docTurn(1, 'assistant', 'Demo: the survey window and the demo tenant improvement allowance are both unresolved.', '2026-09-10T13:05:30.000Z'),
        docTurn(2, 'human', 'Demo: when does the survey window close?', '2026-09-10T13:07:00.000Z'),
        docTurn(3, 'assistant', 'Demo: the demo window closes thirty days after the demo effective date.', '2026-09-10T13:07:20.000Z'),
        docTurn(4, 'human', 'Demo: the counterparty pasted <script>alert(1)</script> into the demo portal.', '2026-09-10T13:09:00.000Z'),
        docTurn(5, 'assistant', 'Demo: recorded verbatim, including "><img onerror=alert(2) src=x>, and never executed.', '2026-09-10T13:09:40.000Z'),
        docTurn(6, 'human', 'Demo: keep this one private for now.', '2026-09-10T13:12:00.000Z'),
      ],
      grants: [],
    })],
    [DOC_SHARED, docConversation({
      id: DOC_SHARED, title: 'Demo — Crestview derm site search', version: 2, created_by: 'joe',
      visibility: 'shared',
      pinned_at: '2026-09-11T09:00:00.000Z',
      turns: [
        docTurn(0, 'human', 'Demo: which Crestview demo suites are still on the short list?', '2026-09-11T08:40:00.000Z'),
        docTurn(1, 'assistant', 'Demo: three demo suites remain, and one demo landlord has not answered.', '2026-09-11T08:40:25.000Z'),
        docTurn(2, 'human', 'Demo: share this one so the demo partner can read it.', '2026-09-11T08:45:00.000Z'),
        docTurn(3, 'assistant', 'Demo: sharing is a record-layer grant, and it is revocable.', '2026-09-11T08:45:30.000Z'),
      ],
      grants: [{ grantee_actor: partnerActor, granted_at: '2026-09-11T08:46:00.000Z', granted_by_actor: 'joe', revoked_at: null }],
    })],
    [DOC_REVOKED, docConversation({
      id: DOC_REVOKED, title: 'Demo — Coastal survey follow-up', version: 4, created_by: 'joe',
      visibility: 'private',
      archived_at: '2026-09-12T17:00:00.000Z',
      turns: [
        docTurn(0, 'human', 'Demo: has the demo surveyor answered yet?', '2026-09-12T15:10:00.000Z'),
        docTurn(1, 'assistant', 'Demo: no demo answer since Monday.', '2026-09-12T15:10:30.000Z'),
        docTurn(2, 'human', 'Demo: put it away, and take the demo partner back off it.', '2026-09-12T16:55:00.000Z'),
      ],
      grants: [{ grantee_actor: partnerActor, granted_at: '2026-09-12T15:20:00.000Z', granted_by_actor: 'joe', revoked_at: '2026-09-12T16:58:00.000Z' }],
    })],
    // Shared creation inserts no grants; creator-or-unrevoked-grant still gates reads (0520:186-189).
    [DOC_SHARED_NO_GRANT, docConversation({
      id: DOC_SHARED_NO_GRANT, title: 'Demo — Navarre imaging suite, shared at birth', version: 1, created_by: 'joe',
      visibility: 'shared',
      turns: [
        docTurn(0, 'human', 'Demo: start this one shared so I do not forget to share it.', '2026-09-13T10:00:00.000Z'),
        docTurn(1, 'assistant', 'Demo: the header says shared; nobody holds a grant until you issue one.', '2026-09-13T10:00:20.000Z'),
      ],
      grants: [],
    })],
  ]);
  const docSuggestions = new Map([
    ['d0000000-0000-4000-8000-000000000081', {
      id: 'd0000000-0000-4000-8000-000000000081', conversation_id: DOC_PRIVATE,
      material_facts: { page:'deals', record_kind: 'deal', record_id: 'd14', record_version: 1 },
      obligation_key: 'demo:gulf-breeze:survey-window', material_version: 1, version: 1,
      source_sequence: 1, original_text: docConversations.get(DOC_PRIVATE).turns[1].body,
      polished_text: 'Confirm the survey window before the LOI moves forward.',
      uncertainty: 'The effective date has not been recorded.', contributor: 'Doc',
      source_at: '2026-09-10T13:05:30.000Z', suggested_at: '2026-09-10T13:06:00.000Z',
      disposition: 'open', dismissed_material_version: null, snoozed_material_version: null,
      contributions: [{ original_text: docConversations.get(DOC_PRIVATE).turns[1].body,
        contributor: 'Doc', at: '2026-09-10T13:05:30.000Z' }],
    }],
    ['d0000000-0000-4000-8000-000000000082', {
      id: 'd0000000-0000-4000-8000-000000000082', conversation_id: DOC_PRIVATE,
      obligation_key: 'demo:gulf-breeze:allowance', material_version: 1, version: 1,
      source_sequence: 1, original_text: docConversations.get(DOC_PRIVATE).turns[1].body,
      polished_text: 'Confirm the survey window before the LOI moves forward.',
      uncertainty: 'The tenant improvement allowance is unresolved.', contributor: 'Doc',
      source_at: '2026-09-10T13:05:30.000Z', suggested_at: '2026-09-10T13:06:01.000Z',
      disposition: 'open', dismissed_material_version: null, snoozed_material_version: null,
      contributions: [{ original_text: docConversations.get(DOC_PRIVATE).turns[1].body,
        contributor: 'Doc', at: '2026-09-10T13:05:30.000Z' }],
    }],
  ]);
  const docCorrections = new Map();
  /**
   * Written by every rename and read back by nothing, exactly as
   * `ops.doc_conversation_title_revision` is written and projected by no verb.
   * It exists here so a test can prove the page does NOT show it.
   */
  const docTitleRevisions = [];
  /** What each spent key was spent ON; a different payload is `key_reuse`. */
  const docIdemArgs = new Map();
  const docSuggestionResults = new Map();

  const docLiveGrants = (row) => row.grants.filter((grant) => !grant.revoked_at);
  /** 0523:196-201: a revoke recomputes the column from what is LEFT unrevoked. */
  const docRecomputeVisibility = (row) => {
    row.visibility = docLiveGrants(row).length ? 'shared' : 'private';
    return row.visibility;
  };
  const docVisibleTo = (row, actor) => Boolean(row) && (row.created_by === actor
    || docLiveGrants(row).some((grant) => grant.grantee_actor === actor));
  const docVisibleCount = (actor) => [...docConversations.values()]
    .filter((row) => docVisibleTo(row, actor)).length;
  /**
   * The envelope's key check, which fires BEFORE the function: a key already
   * spent on different arguments is `key_reuse`, which is what the app actually
   * sees. (The store's own `doc_conversation_idempotency_key_reuse` is reachable
   * only when a conversation row exists with no matching tool_call row, and is
   * shadowed by this one everywhere the app can reach.)
   */
  function docGuardKey(verb, key, args) {
    if (!key) refuse(verb, 'missing_idempotency_key');
    const signature = JSON.stringify({ verb, args, actor: selfActor });
    const seen = docIdemArgs.get(key);
    if (seen && seen !== signature) refuse(verb, 'key_reuse', { idempotency_key: key });
    docIdemArgs.set(key, signature);
  }

  const held = (row) => ({
    human_ref: row.human_ref, title: row.title, state: row.state, owner: row.owner,
    executor: row.executor, done_predicate: row.done_predicate, blocker: row.blocker || null,
    program: { key: 'demo-program', sequence: row.sequence }, held_since: row.held_since,
    hours_since_last_change: row.hours_since_last_change,
  });
  const heldWork = [
    held({ human_ref: 'WR-000901', title: 'Demo bounded request: reconcile the demo vendor rows', state: 'in_progress', owner: 'joe', executor: 'claude', done_predicate: ['Demo vendor rows reconcile against the demo source'], sequence: 1, held_since: '2026-09-16T12:00:00.000Z', hours_since_last_change: 3.5 }),
    held({ human_ref: 'WR-000902', title: 'Demo bounded request: publish the demo coverage note', state: 'blocked', owner: 'joe', executor: 'dell', done_predicate: ['The demo coverage note is published'], sequence: 2, held_since: '2026-09-14T08:00:00.000Z', hours_since_last_change: 51.2, blocker: { code: 'counterparty', detail: 'Demo Coastal Surveying has not answered since Monday' } }),
    held({ human_ref: 'WR-000903', title: 'Demo bounded request: verify the demo release evidence', state: 'verification', owner: 'dell', executor: 'dell', done_predicate: ['A demo consumer receipt exists for every clause'], sequence: 3, held_since: '2026-09-15T16:30:00.000Z', hours_since_last_change: 19 }),
  ];
  const sharedRequests = [
    { human_ref: 'WR-000904', title: 'Demo bounded request: decide the demo retention window', state: 'needs_joe', source: { label: 'Demo council minute', freshness: 'fresh' }, next_human_action: 'Name the demo retention window' },
    { human_ref: 'WR-000905', title: 'Demo bounded request: accept the demo ready plan', state: 'needs_joe', source: { label: 'Demo ready plan', freshness: 'stale' }, next_human_action: 'Accept or decline the demo ready plan' },
    { human_ref: 'WR-000906', title: 'Demo bounded request: reconcile the demo vendor names', state: 'needs_joe', source: { label: 'Demo vendor merge review', freshness: 'fresh' }, next_human_action: 'Confirm the demo vendor merge' },
    { human_ref: 'WR-000907', title: 'Demo bounded request: publish the demo rate card', state: 'needs_joe', source: { label: 'Demo rate card review', freshness: 'stale' }, next_human_action: 'Approve or hold the demo rate card' },
    { human_ref: 'WR-000908', title: 'Demo bounded request: retire the demo legacy export', state: 'needs_joe', source: { label: 'Demo retirement note', freshness: 'fresh' }, next_human_action: 'Confirm the demo legacy export is retired' },
  ];
  // Producer 0493 orders acting_identity by acted_at and feedback oldest first.
  // recommended_answer and business_impact are absent from the pinned interface.
  const sharedRequestCards = new Map([
    ['WR-000910', {
      ok: true, human_ref: 'WR-000910', title: 'Demo lease abstract importer', desired_outcome: 'Demo lease abstracts import without retyping.',
      state: 'in_progress', version: 5, projection_state: 'queued',
      acceptance_criteria: [{ id: 'AC-1', text: 'A demo abstract imports with every date field filled.' }, { id: 'AC-2', text: 'A malformed demo abstract is refused with a reason.' }],
      source: { label: 'Demo leasing backlog', freshness: 'fresh' },
      triage: { classification: 'feature', human_actor_slug: 'joe', triaged_at: '2026-10-09T15:05:00Z' },
      plan: null, outcome_feedback: null, pending_outcome_feedback: null, outcome_feedback_history: [], accepted_feedback_count: 0,
      incident_evidence: [], shape: null, withdrawal: null,
      acting_identity: [
        { act: 'report-problem', recorded_as: 'joe', performed_by: 'joe', authorization_class: null, via: 'mcp', hand: 'human', acted_at: '2026-10-09T14:40:00Z' },
        { act: 'review-and-triage', recorded_as: 'joe', performed_by: 'joe', authorization_class: null, via: 'mcp', hand: 'human', acted_at: '2026-10-09T15:05:00Z' },
        { act: 'accept-ready-plan', recorded_as: 'joe', performed_by: 'claude', authorization_class: 'sponsored_agent', via: 'mcp', hand: 'agent', acted_at: '2026-10-11T10:20:00Z' },
        { act: 'mark-slice-progress', recorded_as: 'joe', performed_by: 'claude', authorization_class: 'sponsored_agent', via: 'mcp', hand: 'agent', acted_at: '2026-10-13T16:02:00Z' },
        { act: 'mark-slice-progress', recorded_as: 'joe', performed_by: 'claude', authorization_class: 'sponsored_agent', via: 'mcp', hand: 'agent', acted_at: '2026-10-14T11:47:00Z' },
        { act: 'mark-slice-progress', recorded_as: 'joe', performed_by: 'claude', authorization_class: 'sponsored_agent', via: 'mcp', hand: 'agent', acted_at: '2026-10-15T09:31:00Z' },
      ],
      next_human_action: { label: 'Review the importer once slice 2 lands', effect: 'none' }, actions: [],
    }],
    ['WR-000911', {
      ok: true, human_ref: 'WR-000911', title: 'Demo vendor merge waits on a name decision', desired_outcome: null,
      state: 'blocked', version: 2, projection_state: 'queued', acceptance_criteria: [],
      source: { label: 'Demo vendor cleanup', freshness: 'fresh' },
      triage: { classification: 'data_quality', human_actor_slug: 'joe', triaged_at: '2026-10-08T13:00:00Z' },
      plan: null, outcome_feedback: null, pending_outcome_feedback: null, outcome_feedback_history: [], accepted_feedback_count: 0,
      incident_evidence: [], shape: null, withdrawal: null,
      acting_identity: [
        { act: 'review-and-triage', recorded_as: 'joe', performed_by: 'joe', authorization_class: null, via: 'mcp', hand: 'human', acted_at: '2026-10-08T13:00:00Z' },
      ],
      next_human_action: { label: 'Choose the canonical name for Demo Coastal Surveying', effect: 'none' }, actions: [],
    }],
    ['WR-000906', {
      ok: true, human_ref: 'WR-000906', title: 'Demo bounded request: reconcile the demo vendor names',
      desired_outcome: 'Every demo vendor row resolves to exactly one canonical demo vendor name.',
      state: 'needs_joe', version: 3, projection_state: 'queued',
      acceptance_criteria: [{ id: 'AC-1', text: 'No two demo vendor rows share a canonical name after the merge.' }],
      source: { label: 'Demo vendor merge review', freshness: 'fresh' },
      triage: { classification: 'data_quality', human_actor_slug: 'joe', triaged_at: '2026-09-19T14:00:00Z' },
      plan: null, outcome_feedback: null, pending_outcome_feedback: null, outcome_feedback_history: [],
      accepted_feedback_count: 0,
      incident_evidence: [
        { kind: 'incident', ref: 'INC-20260918-01', label: 'Demo vendor duplication incident' },
        { kind: 'link', ref: 'https://example.invalid/demo-vendor-merge-review', label: 'Demo vendor merge review note' },
      ],
      shape: null, withdrawal: null,
      acting_identity: [
        { act: 'review-and-triage', recorded_as: 'joe', performed_by: 'joe', authorization_class: null, via: 'mcp', hand: 'human', acted_at: '2026-09-19T14:00:00Z' },
        { act: 'accept-ready-plan', recorded_as: 'joe', performed_by: 'claude', authorization_class: 'sponsored_agent', via: 'mcp', hand: 'agent', acted_at: '2026-09-20T09:15:00Z' },
      ],
      next_human_action: { label: 'Confirm the demo vendor merge', effect: 'none' }, actions: [],
    }],
    ['WR-000907', {
      ok: true, human_ref: 'WR-000907', title: 'Demo bounded request: publish the demo rate card',
      desired_outcome: null,
      state: 'needs_joe', version: 1, projection_state: 'queued',
      acceptance_criteria: [],
      source: { label: 'Demo rate card review', freshness: 'stale' },
      triage: null, plan: null, outcome_feedback: null, pending_outcome_feedback: null,
      outcome_feedback_history: [], accepted_feedback_count: 0,
      incident_evidence: [],
      shape: null, withdrawal: null, acting_identity: [],
      next_human_action: { label: 'Approve or hold the demo rate card', effect: 'none' }, actions: [],
    }],
  ]);

  /* ------------------------------------------------ search fixtures (V5-UX-B05)
   * The synthetic twin of `find` and `find-and-catch-up`, reproducing the
   * PRODUCER'S semantics rather than a friendlier version of them:
   *
   *  - two predicates ORed, as in tools.js:2140-2144 — a case-insensitive
   *    substring (`display_name ilike '%q%'`) and a similarity stand-in;
   *  - `merged` first, then similarity descending (:2145) — the survivors-first
   *    repair from loop #132, which a fixture that sorted on similarity alone
   *    would silently undo;
   *  - the caps as numbers copied from the producer;
   *  - refusal codes exactly as captured from the live verbs.
   *
   * Every name starts with "Demo " so nothing here can be mistaken for a record.
   */
  const SEARCH_CAPS = { parties: 10, organizations: 5, deals: 5, connections: 12, retiredRefs: 10, links: 20, candidates: 25 };

  /**
   * A STAND-IN for `pg_trgm`, and named as one. It is a deterministic trigram
   * overlap ratio over lowercased names with a 0.3 floor. It is NOT similarity
   * as Postgres computes it, and this fixture does not claim to reproduce that
   * ranking — it claims only to rank deterministically so a test can assert the
   * order the page must not disturb.
   */
  function trigrams(value) {
    const padded = `  ${String(value).toLowerCase().trim()} `;
    const out = new Set();
    for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
    return out;
  }
  function searchSimilarity(name, query) {
    const a = trigrams(name);
    const b = trigrams(query);
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const gram of b) if (a.has(gram)) shared += 1;
    return shared / (a.size + b.size - shared);
  }
  const SEARCH_SIMILARITY_FLOOR = 0.3;
  function searchMatches(name, query) {
    const needle = String(query).toLowerCase();
    return String(name).toLowerCase().includes(needle) || searchSimilarity(name, query) >= SEARCH_SIMILARITY_FLOOR;
  }

  /** `kindFromRef` (tools.js:2065-2071), copied prefix for prefix. */
  function searchKindFromRef(ref) {
    const value = String(ref || '');
    if (value.startsWith('C-')) return 'client';
    if (value.startsWith('L-')) return 'lead';
    if (value.startsWith('V-')) return 'vendor';
    if (value.startsWith('P-')) return 'party';
    return 'record';
  }

  const searchParties = [
    { name: 'Demo Pensacola Family Dentistry', city: 'Pensacola', specialty: 'General dentistry', org_name: 'Demo Gulf Coast Dental Group', ref: 'L-901', kind: 'lead', merged: false },
    { name: 'Demo Pensacola Orthopedic Partners', city: null, specialty: null, org_name: null, ref: 'C-900', kind: 'client', merged: false },
    { name: 'Demo Pensacola Buildout Contractors', city: 'Pensacola', specialty: null, org_name: null, ref: 'V-903', kind: 'vendor', merged: false },
    { name: 'Demo Pensacola Referring Physician', city: null, specialty: null, org_name: null, ref: null, kind: 'party', merged: false },
    { name: 'Demo Pensacola Smiles (retired alias)', city: null, specialty: null, org_name: null, ref: 'L-904', kind: 'lead', merged: true },
  ];

  const searchOrganizations = [
    { name: 'Demo Pensacola Imaging Partners', live_rows: 1, refs: [null], retired_aliases: 0, retired_refs: [], retired_refs_truncated: false, live_as_role: 0, role_refs: [], all_retired: false },
    { name: 'Demo Example Organization 093', live_rows: 1, refs: [null], retired_aliases: 0, retired_refs: [], retired_refs_truncated: false, live_as_role: 1, role_refs: ['C-901'], all_retired: false },
    { name: 'Demo Pensacola Surgical Suites', live_rows: 2, refs: ['P-906', 'P-907'], retired_aliases: 0, retired_refs: [], retired_refs_truncated: false, live_as_role: 0, role_refs: [], all_retired: false },
    { name: 'Demo Pensacola Retired Holdings', live_rows: 0, refs: [], retired_aliases: 3, retired_refs: ['P-908', 'P-909', 'P-910'], retired_refs_truncated: false, live_as_role: 0, role_refs: [], all_retired: true },
    { name: 'Demo Pensacola Legacy Practices', live_rows: 1, refs: ['P-911'], retired_aliases: 12, retired_refs: ['P-912', 'P-913', 'P-914', 'P-915', 'P-916', 'P-917', 'P-918', 'P-919', 'P-920', 'P-921'], retired_refs_truncated: true, live_as_role: 0, role_refs: [], all_retired: false },
  ];

  const searchDeals = [
    { name: 'Demo Pensacola distribution warehouse', phase: 'pending', owner: null, client_ref: 'C-900',
      invoiced_on: null, closed_on: null, lane: 'local', outcome: null },
    { name: 'Demo Pensacola medical office building', phase: 'research', owner: 'joe', client_ref: null,
      invoiced_on: null, closed_on: null, lane: null, outcome: null },
    { name: 'Demo Pensacola medical office building', phase: 'legal', owner: 'dell', client_ref: 'C-900',
      invoiced_on: '2026-10-17', closed_on: '2026-10-16', lane: 'national', outcome: 'won' },
  ];

  const searchConnections = [
    { from_ref: 'P-906', from_name: 'Demo Pensacola Surgical Suites', kind: 'refers_to', to_ref: 'L-901', to_name: 'Demo Pensacola Family Dentistry', note: 'introduced at a demo society meeting' },
    { from_ref: null, from_name: 'Demo Pensacola Referring Physician', kind: 'works_with', to_ref: 'C-900', to_name: 'Demo Pensacola Orthopedic Partners', note: null },
  ];

  const searchLeadClientLinks = [
    { lead_ref: 'L-901', lead_name: 'Demo Pensacola Family Dentistry', client_ref: 'C-900', client_name: 'Demo Pensacola Orthopedic Partners', link_basis: 'conversion' },
    { lead_ref: 'C-901', lead_name: 'Demo Example Organization 093', client_ref: 'C-900', client_name: 'Demo Pensacola Orthopedic Partners', link_basis: 'same_party' },
    { lead_ref: 'L-904', lead_name: 'Demo Pensacola Smiles (retired alias)', client_ref: 'C-900', client_name: 'Demo Pensacola Orthopedic Partners', link_basis: 'same_org' },
  ];
  const searchDealsViaLink = [
    { name: 'Demo Pensacola distribution warehouse', phase: 'pending', owner: null, client_ref: 'C-900',
      invoiced_on: null, closed_on: null, lane: 'local', outcome: null },
  ];

  /**
   * The `note`, assembled from the producer's branches. The first sentence is
   * VERBATIM from a live capture; the other three are this fixture's honest
   * rendering of the same branches, and are marked as such here rather than
   * presented as captured text.
   */
  function searchNote(organizations, parties) {
    const retiredOrganizations = organizations.filter((row) => row.retired_aliases > 0 || row.all_retired);
    const retiredParties = parties.filter((row) => row.merged === true);
    if (retiredOrganizations.length === 0 && retiredParties.length === 0) {
      return 'No retired aliases among these matches — every ref listed is live.';
    }
    if (organizations.length > 0 && organizations.every((row) => row.all_retired)) {
      return 'Every organization matched here is retired — no live ref remains behind these names.';
    }
    if (retiredOrganizations.some((row) => row.retired_refs_truncated)) {
      return 'Some matches carry retired aliases, and the list of retired refs was truncated — the counts beside each name are the full ones.';
    }
    return 'Some matches carry retired aliases — they are listed apart from the live refs and are never counted with them.';
  }

  /**
   * `findCatchUpCandidates` (tools.js:2079-2111), reimplemented exactly: live
   * parties only, every non-empty string in `refs` and `role_refs`, every named
   * deal with NO deduplication, ordered by `target.localeCompare`. A client that
   * guessed at a single candidate fails against this.
   */
  function searchCandidates(payload) {
    const out = [];
    const seen = new Set();
    for (const row of payload.parties) {
      if (row.merged !== false) continue;
      const target = row.name;
      if (seen.has(`party|${target}`)) continue;
      seen.add(`party|${target}`);
      out.push({ kind: typeof row.ref === 'string' && row.ref !== '' ? searchKindFromRef(row.ref) : 'record', name: row.name, target });
    }
    for (const row of payload.organizations) {
      for (const ref of [...row.refs, ...row.role_refs]) {
        if (typeof ref !== 'string' || ref === '') continue;
        if (seen.has(`org|${row.name}`)) continue;
        seen.add(`org|${row.name}`);
        out.push({ kind: searchKindFromRef(ref), name: row.name, target: row.name });
      }
    }
    for (const row of payload.deals) {
      if (typeof row.name !== 'string' || row.name === '') continue;
      out.push({ kind: 'deal', name: row.name, target: row.name });
    }
    return out.sort((a, b) => a.target.localeCompare(b.target));
  }

  function searchFind(query) {
    const parties = searchParties
      .filter((row) => searchMatches(row.name, query))
      .sort((a, b) => (Number(a.merged) - Number(b.merged)) || (searchSimilarity(b.name, query) - searchSimilarity(a.name, query)))
      .slice(0, SEARCH_CAPS.parties)
      .map((row) => ({ ...row }));
    const organizations = searchOrganizations
      .filter((row) => searchMatches(row.name, query))
      .sort((a, b) => searchSimilarity(b.name, query) - searchSimilarity(a.name, query))
      .slice(0, SEARCH_CAPS.organizations)
      .map((row) => ({ ...row, refs: [...row.refs], retired_refs: [...row.retired_refs].slice(0, SEARCH_CAPS.retiredRefs), role_refs: [...row.role_refs] }));
    const deals = searchDeals.filter((row) => searchMatches(row.name, query)).slice(0, SEARCH_CAPS.deals).map((row) => ({ ...row }));
    const names = new Set([...parties.map((row) => row.name), ...organizations.map((row) => row.name), ...deals.map((row) => row.name)]);
    const connections = searchConnections
      .filter((row) => names.has(row.from_name) || names.has(row.to_name))
      .slice(0, SEARCH_CAPS.connections).map((row) => ({ ...row }));
    const lead_client_links = searchLeadClientLinks
      .filter((row) => names.has(row.lead_name) || names.has(row.client_name))
      .slice(0, SEARCH_CAPS.links).map((row) => ({ ...row }));
    const deals_via_link = (lead_client_links.length > 0 ? searchDealsViaLink : []).slice(0, SEARCH_CAPS.links).map((row) => ({ ...row }));
    return {
      parties, deals, connections, organizations, lead_client_links, deals_via_link,
      note: searchNote(organizations, parties),
    };
  }

  function fixtureCalendar() {
    const deal = [...deals.values()].find(row => row.owner === selfActor && !isClosedDeal(row));
    const start = new Date(Date.parse(nowIso()) + 3_600_000).toISOString();
    return { state: 'partial', observed_at: nowIso(), notes: ['Synthetic calendar. Check Outlook for attendance and cancellations.'],
      sources: { outlook_calendar: { state: 'partial' }, deal_suggestions: { state: 'ready' }, meeting_prep: { state: 'ready' } },
      match_basis: 'attendee_email_possible_match', items: [{ title: 'Demo practice planning', start,
        end: new Date(Date.parse(start) + 3_600_000).toISOString(), location: 'Demo office', attendee_count: 2,
        all_day: false, schedule_conflict: false, time_changed: false, possible_deals: deal ? [{ id: deal.id, name: deal.name, client_ref: deal.client_ref,
          prep: { state: 'ready', phase: deal.phase ?? null, next_step: deal.next_step ?? null, next_date: deal.next_date ?? null, last_touch: deal.last_touch ?? null, market: deal.market ?? null } }] : [] }],
    };
  }

  const industryEvents = new Map();
  const invoices = createInvoiceFixture({ actor: selfActor, entries: opts.invoiceEntries, today: opts.today });
  function actionsFor(deal) {
    return [...(deal.email_actions || []), ...(deal.next_step ? [{ id: `a-${deal.id}`, owner: deal.owner,
      description: deal.next_step, due_on: deal.next_date, status: 'open' }] : [])];
  }

  function activitiesFor(dealId) {
    return (history.get(dealId) || []).filter(h => h.kind !== 'field_edit').map(h => ({ id: h.id, actor: h.actor,
      occurred_at: h.recorded_at, kind: 'note', summary: h.summary }))
      .sort((a, b) => compareInstants(a.occurred_at, b.occurred_at) || b.id.localeCompare(a.id));
  }

  function boardSteps(deal) {
    const open_actions = actionsFor(deal).filter(action => action.status === 'open')
      .sort((a, b) => (a.due_on || '9999').localeCompare(b.due_on || '9999') || a.id.localeCompare(b.id))
      .slice(0, 3).map(({ id, owner, description, due_on }) => ({ id, owner, description, due_on }));
    const completed = actionsFor(deal).filter(action => action.status === 'done' && action.completed_at)
      .map(action => ({ id: action.id, kind: 'completed_action', summary: action.outcome || action.description, occurred_at: action.completed_at }));
    const last = [...activitiesFor(deal.id), ...completed]
      .sort((a, b) => compareInstants(a.occurred_at, b.occurred_at) || b.id.localeCompare(a.id))[0];
    return { open_actions, last_step: last ? { kind: last.kind, summary: last.summary, occurred_at: last.occurred_at } : null };
  }

  const emailSeedDeals = [...deals.values()].map(({ id, phase }) => ({ id, phase }));
  const client = {
    ...invoices,
    async getRelationshipNetwork() { return relationshipNetworkFixture(); },
    mode: /** @type {const} */ ('fixture'),
    selfActor,

    async setProspectEngagementStatus(args) {
      return withIdem(args.idempotency_key, () => {
        const rows = [...deals.values()].filter(d => d.client_id === args.client_id);
        if (!rows.length || rows.some(d => d.client_status !== 'prospect') || !rows.some(d => !isClosedDeal(d))) refuse('set-prospect-engagement-status', 'not_a_prospect');
        if (args.expected_actor && args.expected_actor !== selfActor) refuse('set-prospect-engagement-status', 'account_changed');
        if (!['active','inactive'].includes(args.status) || !args.reason?.trim()) refuse('set-prospect-engagement-status', 'invalid_engagement_status');
        if (rows.some(d => d.client_version !== args.base_version)) refuse('set-prospect-engagement-status', VERSION_CONFLICT);
        const client_version = args.base_version + 1;
        rows.forEach(d => Object.assign(d, { prospect_engagement_status: args.status, client_version }));
        return { ok:true, client_id:args.client_id, prospect_engagement_status:args.status, client_version };
      });
    },

    async getBoard() {
      const today = (opts.today || localToday)();
      const eligible = [...deals.values()].filter(d => d.client_status !== 'prospect' || d.prospect_engagement_status === 'active');
      const national = eligible.filter((d) => d.account_client_id === fixtureAccountId && !d.invoiced_on);
      const activeNational = national.filter((d) => d.operating_state === 'active');
      return {
        schema_version: 'local-deals-board.v2',
        actor: selfActor,
        deals: eligible.filter(d => !d.invoiced_on).map((d) => ({ ...d, ...boardSteps(d), phase_change: phaseChangeFor(d.id), field_base: fieldBaseFor(d.id) })),
        lost_deals: [...deals.values()].filter(d => d.outcome === 'lost').map(d => ({...d})),
        closed_deals: [...deals.values()].filter(d => (d.outcome === 'won' || !d.outcome && (d.closed_on || d.invoiced_on))).map(d => ({...d})),
        accounts: [{ account_client_id: fixtureAccountId, account_client_ref: 'DEMO-ACCOUNT-001',
          account_name: 'Demo National Practice', account_owner: fixtureAccountOwner, base_version: fixtureAccountVersion, client_version: fixtureAccountVersion, open_deals: activeNational.length,
          attention_deals: activeNational.filter((d) => d.attention).length,
          overdue_deals: activeNational.filter((d) => d.next_date && d.next_date < today).length,
          stale_deals: activeNational.filter((d) => !d.last_touch || d.last_touch <= addDays(today, -14)).length,
          parked_deals: national.length - activeNational.length, last_review_at: lastCallAt }],
        open_session: [...reviewSessions.values()].find((s) => s.status === 'open') || null,
        as_of: asOf,
        last_call_at: lastCallAt,
      };
    },

    async getPostCallFollowups() { return { schema_version: 'post-call-followups.v1', candidates: [], send: false }; },

    async listPracticeOrigination(args = {}) { const {practiceOriginationFixture} = await import('../data/fixtures/practice-origination.mjs'); return practiceOriginationFixture(args); },

    async getHomeAgenda() {
      const board = await this.getBoard();
      return { ...board, schema_version: 'home-agenda.v1', deals: board.deals.map(deal => ({
        ...deal,
        critical_dates: [...(deal.next_date ? [{ label: deal.next_step || 'Follow-up due', date: deal.next_date }] : []),
          ...(criticalDates.get(deal.id) || []).map(row => ({ ...row }))],
        next_actions: actionsFor(deal),
      })) };
    },

    async listDealDocuments(args) { return (await factReviews()).listDealDocuments(args); },
    async prepareTermsComparison(args, { signal } = {}) { const fixture = await factReviews(); signal?.throwIfAborted(); return fixture.prepareTermsComparison(args); },
    async listFactReview(args) { return (await factReviews()).listFactReview(args); },
    async recordHumanFact(args, { signal } = {}) { const fixture = await factReviews(); signal?.throwIfAborted(); return fixture.recordHumanFact(args); },
    async resolveFactReview(args, { signal } = {}) { const fixture = await factReviews(); signal?.throwIfAborted(); return fixture.resolveFactReview(args); },

    async readMarketTerms(args = {}) { return readMarketTerms(args); },
    async getDeal(dealId) {
      const deal = { ...getDealOrThrow(dealId) };
      const thread = (threads.get(dealId) || [])
        .slice()
        .sort((a, b) => compareInstants(a.at || a.created_at || a.recorded_at, b.at || b.created_at || b.recorded_at));
      const hist = (history.get(dealId) || [])
        .slice()
        .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
      const critical_dates = [];
      if (deal.next_date) {
        critical_dates.push({
          label: deal.next_step || 'Follow-up due',
          date: deal.next_date,
        });
      }
      for (const entry of criticalDates.get(dealId) || []) critical_dates.push({ ...entry });
      return { items: structuredClone(deal.items || []), item_schema_version: 'deal-items.v1', deal: {...deal, phase_change: phaseChangeFor(dealId)}, thread, critical_dates, history: hist,
        next_actions: actionsFor(deal),
        activities: activitiesFor(dealId).slice(0, 4),
        participants: [{ role: 'lead', name: actorLabel(deal.owner), actor: deal.owner },
          ...(extraParticipants.get(dealId) || [])],
        premises: [], negotiation_rounds: [], attachments: (await factReviews()).attachments(dealId), documents: [], lease: null, schema_version: 'deal-timeline.v1' };
    },

    async readAssuranceHealth(args) {
      const { assuranceHealthRequest, ASSURANCE_LAYERS } = await import('./assurance-health-model.js');
      const { scope } = assuranceHealthRequest(args);
      refuseIfOutage('assurance', 'read-assurance-health');
      const evidence = Object.fromEntries(ASSURANCE_LAYERS.map(layer => [layer, {
        layer, state: layer === 'actual_business_outcome' && !scope.work_request_id ? 'unbindable' : 'missing', present: false, scope: { ...scope },
      }]));
      return { schema_version: 'assurance-health.v1', scope, state: 'unknown', green: false,
        state_reason: 'Demo fixture: authoritative workflow truth is unavailable.', capability_stage: 'unavailable',
        capability_stage_attributable_to_findings: 'unavailable',
        workflow_truth: { available: false, source: 'V5-F09 workflow census', reason: 'Demo workflow truth is unavailable.' },
        owner: { kind: 'record_layer', ref: 'ops.assurance_health_evidence' }, evidence,
        failing_layers: [], indeterminate_layers: [], missing_layers: ASSURANCE_LAYERS.filter(layer => evidence[layer].state === 'missing'),
        unbindable_layers: ASSURANCE_LAYERS.filter(layer => evidence[layer].state === 'unbindable'), reasons: [],
        impact: { scope_limited_to: { ...scope }, withdrawn_stages: ['act', 'draft', 'read'] }, recovery: { required_evidence: [...ASSURANCE_LAYERS] } };
    },
    async correspondenceReadiness(args = {}) {
      readinessRequest(args);
      return structuredClone({ ok: true, schema_version: 'doctorcre-v5-j103-correspondence-store.v1',
        readiness: { server_instant: '2026-09-30T12:00:00Z', partners: [{ partner_slug: 'demo-partner',
          consents_in_force: 0, consents_revoked: 0, read_receipts: 0, drafts: 0 }], read_receipt_writer_granted_to_runtime: false },
        mailbox_reads_possible: false, activation: { human_step: { step: 'demo-local-store-consent', owner: 'Demo partner', what: 'Synthetic consent step' },
          status: 'consent_not_recorded', note: 'Synthetic adapter unavailable' },
        owed: [], kernel_gaps: [], policy: { correspondence: 'demo-policy', journey: 'demo-journey-policy' },
        consentable_operations: [], never_consentable_operations: [], ...CORRESPONDENCE_CEILING });
    },
    async readCorrespondenceThread(args) {
      return structuredClone({ ok: true, decision: 'unavailable', reason_id: 'j103.store.no_read_receipt',
        owed_seam: 'step:journey-one-authorized-adapter-read-receipt', native_identity: threadRequest(args),
        receipts: [], ...CORRESPONDENCE_CEILING });
    },

    async getPartyRecord({ dataset, id }) {
      const record = businessRecords.get(id);
      if (!record) throw new Error(`fixture business record not found: ${dataset}/${id}`);
      return { viewer: selfActor, dataset, record: { ...record } };
    },

    async getJevDealReading() {
      return { schema: 'carr.jev-deal-reading.v1', judged: false, reason: 'jev_unavailable' };
    },

    async getChanges(cursor, { since } = {}) {
      pruneLeases();
      const fresh = eventsAfter(cursor).filter(event => cursor || !since || Date.parse(event.recorded_at) >= Date.parse(since));
      return {
        events: fresh.map((e) => ({ ...e })),
        presence: [...leases.values()].map((p) => ({ ...p })),
        capture_sessions: [],
        cursor: cursorOf(events),
      };
    },

    async presenceLease({ deal, field, idempotency_key }) {
      void idempotency_key;
      getDealOrThrow(deal);
      const expires = new Date(Date.now() + LEASE_TTL_MS).toISOString();
      const key = `${selfActor}|${deal}|${field}`;
      leases.set(key, { actor: selfActor, deal_id: deal, field, expires_at: expires });
      return { ok: true };
    },

    async patchDealField({ deal, field, value, base_event_id, idempotency_key, change_reason, human_quote }) {
      return withIdem(idempotency_key, () =>
        applyFieldWrite({
          deal,
          field,
          value,
          base_event_id: base_event_id ?? null,
          actor: selfActor,
          verb: 'patch-deal-field',
          change_reason,
          human_quote,
        }),
      );
    },

    /**
     * The deal-row write, guarded by the row's own version.
     *
     * It refuses exactly what the record layer refuses: a missing or wrong
     * `base_version`, and an outcome outside `deal_outcome_check`. A fixture
     * that took a fourth outcome, or took a stale base quietly, would let this
     * app ship a dialog the live verb bounces after the phase already moved.
     */
    async updateDeal({ deal, base_version, fields, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const row = getDealOrThrow(deal);
        const patch = fields && typeof fields === 'object' ? fields : {};
        if (!Number.isInteger(base_version)) {
          refuse('update-deal', 'missing_base_version', { hint: 'Re-read the deal and send the version it holds now.' });
        }
        if (Number(base_version) !== Number(row.version)) {
          refuse('update-deal', VERSION_CONFLICT, { deal, resolution: 're-read the deal and decide from what it holds now' });
        }
        if ('outcome' in patch) {
          if (!DEAL_OUTCOMES.includes(patch.outcome)) {
            refuse('update-deal', 'deal_outcome_check', { hint: 'outcome is one of won, lost or paused' });
          }
          row.outcome = patch.outcome;
        }
        if ('closed_on' in patch) {
          const day = String(patch.closed_on || '').trim();
          if (!DAY.test(day)) refuse('update-deal', 'invalid_closed_on', { hint: 'closed_on is a calendar date' });
          row.closed_on = day;
        }
        if ('won_value' in patch) {
          const amount = Number(patch.won_value);
          if (!Number.isFinite(amount)) refuse('update-deal', 'invalid_won_value', { hint: 'won_value is a number' });
          row.won_value = amount;
        }
        row.version = Number(row.version) + 1;
        row.last_touch = nowIso().slice(0, 10);
        const e = pushEvent({
          actor: selfActor, verb: 'update-deal', subject_id: deal, field: null,
          old_value: null, new_value: { ...patch },
        });
        pushHistory(deal, selfActor, 'updated the deal record', e.recorded_at);
        return { ok: true, status: 'ok', deal_id: deal, version: row.version, event: e };
      });
    },

    /**
     * Mirrors register-client-portal: a slug, a password the record layer would hash, and the
     * derived link back. The fixture keeps neither the password nor a hash of it.
     */
    async registerClientPortal({ deal, slug, password, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const row = getDealOrThrow(deal);
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(slug))) refuse('register-client-portal', 'portal_slug_invalid');
        if (!String(password || '').length) refuse('register-client-portal', 'portal_password_invalid');
        if (row.client_portal_url) refuse('register-client-portal', 'portal_deal_already_registered');
        if ([...deals.values()].some((other) => other.client_portal_url === `${PORTAL_ORIGIN}/${slug}`)) {
          refuse('register-client-portal', 'portal_slug_taken');
        }
        row.client_portal_url = `${PORTAL_ORIGIN}/${slug}`;
        return { ok: true, deal_id: deal, client_portal_url: row.client_portal_url, created: true };
      });
    },

    async setLead({ deal, new_lead, base_version, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const row = getDealOrThrow(deal);
        guardVersion(row, base_version);
        if (!['joe', 'dell'].includes(new_lead)) refuse('set-lead', 'unknown_actor');
        const result = applyFieldWrite({ deal, field:'owner', value:new_lead,
          base_event_id:lastFieldEvent.get(`${deal}|owner`) || null, actor:selfActor, verb:'set-lead' });
        row.version += 1;
        return { ...result, ok:true, version:row.version };
      });
    },

    async resolveConflict({ conflict_id, winner, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const c = conflicts.get(conflict_id);
        if (!c) throw new Error(`unknown conflict ${conflict_id}`);
        const d = getDealOrThrow(c.deal);
        const chosen = winner === 'a' ? c.a.value : c.pending_value;
        const actor = winner === 'a' ? selfActor : c.pending_actor;
        const old = c.field === 'operating_state'
          ? { state:d.operating_state, reason:d.parking_reason, note:d.parking_note }
          : d[c.field];
        if (c.field === 'attention') d.attention = !!chosen;
        else if (c.field === 'operating_state') {
          d.operating_state = chosen.state;
          d.parking_reason = chosen.state === 'parked' ? chosen.reason : null;
          d.parking_note = chosen.state === 'parked' ? chosen.note || null : null;
          d.parked_at = chosen.state === 'parked' ? nowIso() : null;
          d.parked_by = chosen.state === 'parked' ? actor : null;
        } else d[c.field] = chosen;
        if (c.field !== 'operating_state') d.last_touch = nowIso().slice(0, 10);
        const e = pushEvent({
          actor,
          verb: 'resolve-conflict',
          subject_id: c.deal,
          field: c.field,
          old_value: old ?? null,
          new_value: chosen ?? null,
        });
        pushHistory(c.deal, actor, `resolved conflict on ${c.field}`, e.recorded_at);
        conflicts.delete(conflict_id);
        return { status: 'ok', event: e };
      });
    },

    async recordDealItem({ deal, title, due_on, bullets, source_ref, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const d = getDealOrThrow(deal);
        const source = source_ref || `app:deal-item:${idempotency_key}`;
        const existing = d.items?.find(item => item.title === title && item.source_ref === source);
        const item = existing || { id: uuidv4(), title, due_on: due_on || null, status: 'open', bullets: structuredClone(bullets), source_ref: source };
        if (!existing) (d.items ||= []).push(item);
        return { status: 'ok', ok: true, item: structuredClone(item), rows_changed: existing ? 0 : 1 };
      });
    },
    async instructDealItem({ deal, item_id, text, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const item = getDealOrThrow(deal).items?.find(row => row.id === item_id);
        if (!item || !text?.trim()) throw new Error('Item or instruction unavailable');
        item.bullets.push({ date: nowIso().slice(0,10), kind: 'status', text: text.trim() });
        return { ok: true, item: structuredClone(item) };
      });
    },
    async completeDealItem({ deal, item_id, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const item = getDealOrThrow(deal).items?.find(row => row.id === item_id);
        if (!item) throw new Error('Item unavailable');
        item.status = 'done';
        return { ok: true, item: structuredClone(item) };
      });
    },

    async answerBoardQuestion({ board_id, question_id, base_version, answer_text, idempotency_key }) {
      if (board_id !== 'calendar-agenda' || !/^[0-9a-f]{16}$/.test(question_id) || base_version !== 1 || answer_text !== 'Dismiss')
        throw new Error('Invalid calendar answer');
      return withIdem(idempotency_key, () => ({ ok: true, answer: { question_id, answer_text } }));
    },

    async logActivity({ ref, kind, summary, occurred_at, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        getDealOrThrow(ref);
        if (kind !== 'meeting' || !String(summary || '').trim() || !Number.isFinite(Date.parse(occurred_at))) throw new Error('Invalid activity');
        pushHistory(ref, selfActor, `logged meeting: ${String(summary).trim()}`, nowIso());
        return { ok: true, activity_id: `a-${dealStore.noteSeq++}`, subject: { type: 'deal', id: ref } };
      });
    },

    async addDealNote({ deal, text, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        getDealOrThrow(deal);
        const t = String(text || '').trim();
        if (!t) throw new Error('empty note');
        const entry = {
          id: `n-${dealStore.noteSeq++}`,
          kind: 'note',
          actor: selfActor,
          text: t,
          recorded_at: nowIso(),
        };
        ensureThread(deal).unshift(entry);
        const e = pushEvent({
          actor: selfActor,
          verb: 'add-deal-note',
          subject_id: deal,
          field: null,
          old_value: null,
          new_value: t,
        });
        pushHistory(deal, selfActor, `added note`, e.recorded_at);
        return { status: 'ok', event: e };
      });
    },

    async addCriticalDate({ deal, kind, due_on, source, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        getDealOrThrow(deal);
        const k = String(kind || '').trim();
        const day = String(due_on || '').trim();
        const from = String(source || '').trim();
        if (!k) throw new Error('critical date kind required');
        if (!day) throw new Error('critical date due_on required');
        if (!from) throw new Error('critical date source required');
        const entry = { id: `cd-${dealStore.criticalDateSeq++}`, kind: k, label: k, due_on: day, date: day, source: from };
        criticalDates.set(deal, [...(criticalDates.get(deal) || []), entry]);
        const e = pushEvent({
          actor: selfActor,
          verb: 'add-critical-date',
          subject_id: deal,
          field: null,
          old_value: null,
          new_value: day,
        });
        pushHistory(deal, selfActor, `added critical date ${k}`, e.recorded_at);
        return { status: 'ok', event: e, critical_date: entry };
      });
    },

    async setNextStep({ deal, text, next_date, base_version, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const d = getDealOrThrow(deal);
        guardVersion(d, base_version);
        const t = String(text || '').trim();
        if (!t) throw new Error('empty next step');
        const old = d.next_step;
        if (old && old.trim()) {
          ensureThread(deal).unshift({
            id: `n-${dealStore.noteSeq++}`,
            kind: 'archived_step',
            actor: selfActor,
            text: old,
            recorded_at: nowIso(),
          });
        }
        d.next_step = t;
        if (next_date !== undefined) d.next_date = next_date || null;
        d.last_touch = nowIso().slice(0, 10);
        d.version += 1;
        const e = pushEvent({
          actor: selfActor,
          verb: 'set-next-step',
          subject_id: deal,
          field: 'next_step',
          old_value: old ?? null,
          new_value: t,
        });
        if (next_date !== undefined) {
          pushEvent({
            actor: selfActor,
            verb: 'patch-deal-field',
            subject_id: deal,
            field: 'next_date',
            old_value: null,
            new_value: next_date,
          });
        }
        pushHistory(deal, selfActor, `set next step to "${t}"`, e.recorded_at);
        return { status: 'ok', event: e };
      });
    },

    async createDeal({ name, client, deal_type, phase, segment, market, lane, owner, notes, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const n = String(name || '').trim();
        if (!n) throw new Error('empty name');
        const initialPhase = phase || 'On Deck';
        if (!PHASES.includes(initialPhase)) refuse('new-deal', 'unknown_phase');
        const id = `d-new-${dealStore.seq++}`;
        const d = {
          id,
          version: 1,
          operating_state: 'active',
          name: n,
          type: deal_type || 'Other',
          phase: initialPhase,
          owner: owner || selfActor,
          attention: false,
          last_touch: nowIso().slice(0, 10),
          next_step: '',
          next_date: null,
          segment: segment || null,
          market: market || null,
          client_ref: client || 'C-demo',
          client_name: client || n,
          workspace_kind: lane === 'national' ? 'national_account' : 'team',
          account_client_id: lane === 'national' ? fixtureAccountId : null,
          account_name: lane === 'national' ? 'Demo National Practice' : null,
        };
        deals.set(id, d);
        if (notes) threads.set(id, [{ id: `note-${dealStore.seq++}`, kind: 'note', actor: selfActor, text: notes, at: nowIso() }]);
        const e = pushEvent({
          actor: selfActor,
          verb: 'create-deal',
          subject_id: id,
          field: null,
          old_value: null,
          new_value: n,
        });
        pushHistory(id, selfActor, 'created from the board', e.recorded_at);
        return { status: 'ok', event: e, deal: { ...d } };
      });
    },

    // read-loop returns a miss in its payload; only refusals throw a classifiable payload.
    async loopBoard({ kind = 'open_loop', status = 'open', domain, blocker, owner, search, limit = 300 } = {}) {
      const rows = loops.filter((row) => row.kind === kind
        && (!status || row.status === status)
        && (!domain || row.domain === domain)
        && (!blocker || row.blocker_class === blocker)
        && (!owner || row.owner === owner)
        && (!search || row.title.toLowerCase().includes(String(search).toLowerCase())))
        .slice(0, Math.min(Number(limit) || 300, 300))
        .map(boardRow);
      return { count: rows.length, loops: rows };
    },

    async listFeatureSwitches() {
      return {ok:true,schema:'feature-switches.v1',switches:[{name:'doc-suggestion-actions',available:true}]};
    },
    async calendarMeetingPrep() { return fixtureCalendar(); },
    async morningBrief() {
      const section = items => ({ state: items.length ? 'ready' : 'empty', items });
      const board = await this.getBoard();
      const sections = {
        ...(selfActor === 'joe' ? { needs_joe: section([]) } : {}),
        claim_card: section([]), renewals: section([]), assurance_cadence: section([]), costs: { ...section([]), providers: [] },
        today: section((await this.todayTriage()).items),
        deals: { state:board.deals.length || board.accounts?.length ? 'ready' : 'empty', items:board.deals, accounts:board.accounts || [] },
        loops: section((await this.loopBoard()).loops),
      };
      return { state:'ready', sponsor:selfActor, sections, coverage: {
        schema:'morning-brief-coverage.v1', count_scope:'returned_rows_only',
        required_sections:Object.entries(sections).map(([key,value]) => ({key,path:`/sections/${key}`,state:value.state,
          counts:Object.fromEntries(['items','accounts','providers'].filter(name => Array.isArray(value[name])).map(name => [name,value[name].length])), incomplete_sources:[]})),
      } };
    },

    async morningBriefQueue(queue, {cursor} = {}) {
      if (!['today','loops','needs_joe','assurance_cadence'].includes(queue) || queue === 'needs_joe' && selfActor !== 'joe') throw Error('Unsupported morning queue.');
      const source = queue === 'today' ? (await this.todayTriage({limit:Infinity})).items
        : queue === 'loops' ? loops.filter(row=>row.kind === 'open_loop' && row.status === 'open' && ['joe','dell'].includes(row.owner)).map(row=>({...boardRow(row),owner_partner:row.owner})) : [];
      const key = row => [row.due_on || '~',row.kind || row.item_kind,String(row.number || row.id)].join('|');
      source.sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);
      const after = cursor ? JSON.parse(decodeURIComponent(atob(cursor))) : null;
      if (after && (after.queue!==queue || after.sponsor!==selfActor)) throw Error('Invalid queue cursor.');
      const available = after ? source.filter(row=>key(row)>after.key) : source;
      const items=available.slice(0,50),has_more=available.length>50;
      return {sponsor:selfActor,items,total:source.length,returned:items.length,remaining:available.length-items.length,has_more,
        next_cursor:has_more?btoa(encodeURIComponent(JSON.stringify({queue,sponsor:selfActor,key:key(items.at(-1))}))):null};
    },

    async todayTriage({ limit = 50 } = {}) {
      const today = businessDay(new Date(nowIso()));
      const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
      const items = [];
      for (const deal of deals.values()) {
        const day = typeof deal.next_date === 'string' ? deal.next_date.slice(0, 10) : null;
        if (deal.next_step && day && day <= today) {
          items.push({ item_kind: 'next_action', id: `a-${deal.id}`, subject_type: 'deal', subject_id: deal.id,
            owner: deal.owner, what: deal.next_step, due_on: day, subject_name: deal.name, subject_ref: null,
            business_days_overdue: null });
        }
        for (const entry of criticalDates.get(deal.id) || []) {
          if (entry.due_on > horizon) continue;
          items.push({ item_kind: 'critical_date', id: entry.id, subject_type: 'deal', subject_id: deal.id,
            owner: null, what: entry.kind, due_on: entry.due_on, subject_name: deal.name, subject_ref: null,
            business_days_overdue: null });
        }
      }
      items.sort((a, b) => a.due_on.localeCompare(b.due_on));
      return { items: items.slice(0, limit) };
    },

    async readLoop({ loop_id, number, kind } = {}) {
      const found = findLoop({ loop_id, number, kind });
      if (found === 'need_number_or_id') return { error: 'need_number_or_id' };
      if (found === 'ambiguous_number') {
        return {
          error: 'ambiguous_number',
          candidates: loops.filter((row) => row.number === String(number)).map((row) => ({ loop_id: row.loop_id, kind: row.kind, title: row.title })),
        };
      }
      if (!found) return { error: 'not_found' };
      return { loop: structuredClone(found) };
    },

    async listIndustryEvents({ limit = 50 } = {}) {
      const rows = [...industryEvents.values()].sort((a, b) =>
        Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.id.localeCompare(b.id)).slice(0, limit);
      return { ok: true, events: structuredClone(rows), count: rows.length };
    },

    async addIndustryEvent({ idempotency_key, ...fields }) {
      return withIdem(idempotency_key || uuidv4(), () => {
        const event = { id: uuidv4(), version: 1, is_virtual: false,
          attendance_intent: 'considering', status: 'planned', ...fields };
        industryEvents.set(event.id, event);
        return { ok: true, event: structuredClone(event) };
      });
    },

    async updateIndustryEvent({ idempotency_key, event_id, base_version, ...fields }) {
      return withIdem(idempotency_key || uuidv4(), () => {
        const current = industryEvents.get(event_id);
        if (!current || current.version !== base_version) refuse('update-industry-event', 'industry_event_version_conflict');
        const event = { ...current, ...fields, version: current.version + 1 };
        industryEvents.set(event_id, event);
        return { ok: true, event: structuredClone(event) };
      });
    },

    async loopHeaders() {
      const blocks = [
        { block_id: 'block-open-hot', file: '00_Context/open-loops.md', kind: 'open_loop', section: 'hot', seq: 1, version: 3, prose_md: 'What is open this week, and what each one is waiting on.' },
        { block_id: 'block-team-open', file: '00_Context/team-loops.md', kind: 'team_loop', section: 'open', seq: 1, version: 2, prose_md: 'Work the partnership holds together.' },
      ];
      return { count: blocks.length, blocks };
    },

    async addLoop({ idempotency_key, kind = 'open_loop', owner, title, body, domain, marker = 'none', due_on, blocker, blocker_detail, unblocks, source_note }) {
      return withIdem(idempotency_key, () => {
        const row = loop({
          kind, owner, title, body, domain, marker, due_on: due_on || null,
          blocker_class: blocker || null, blocker_detail: blocker_detail || null,
          unblocks: unblocks || null, source_note: source_note || 'Captured on the Tasks surface',
          number: String(300 + loops.length), since_text: 'open today',
          created_at: nowIso(), updated_at: nowIso(),
        });
        loops.push(row);
        return {
          ok: true, loop_id: row.loop_id, number: row.number, kind: row.kind,
          section: row.kind, renders_into: 'loop-board', blocker: row.blocker_class,
        };
      });
    },

    async updateLoop({ idempotency_key, loop_id, number, kind, base_version, ...fields }) {
      return withIdem(idempotency_key, () => {
        const found = findLoop({ loop_id, number, kind });
        if (typeof found === 'string' || !found) {
          const error = new Error(`fixture update-loop refused: ${found || 'not_found'}`);
          error.payload = { error: typeof found === 'string' ? found : 'not_found' };
          throw error;
        }
        if (found.status !== 'open') {
          const error = new Error('fixture update-loop refused: loop_not_open');
          error.payload = { error: 'loop_not_open', hint: 'This record is already closed.' };
          throw error;
        }
        guardVersion(found, base_version);
        const allowed = ['title', 'body', 'owner', 'marker', 'due_on', 'domain', 'unblocks', 'source_note'];
        const applied = allowed.filter((field) => fields[field] !== undefined);
        if (fields.blocker !== undefined) applied.push('blocker');
        if (applied.length === 0) {
          const error = new Error('fixture update-loop refused: nothing_to_update');
          error.payload = { error: 'nothing_to_update' };
          throw error;
        }
        if (fields.due_on !== undefined && (fields.marker || found.marker) !== 'dated') {
          const error = new Error('fixture update-loop refused: due_date_needs_dated_marker');
          error.payload = { error: 'due_date_needs_dated_marker' };
          throw error;
        }
        for (const field of allowed) if (fields[field] !== undefined) found[field] = fields[field];
        if (found.marker !== 'dated') found.due_on = null;
        if (fields.blocker !== undefined) {
          found.blocker_class = fields.blocker;
          found.blocker_detail = fields.blocker_detail ?? found.blocker_detail;
        }
        if (fields.owner !== undefined && found.kind !== 'team_loop') found.personal_to = fields.owner;
        found.version = Number(found.version) + 1;
        found.updated_at = nowIso();
        return { ok: true, loop_id: found.loop_id, number: found.number, moved: false, renumbered: false };
      });
    },

    async closeLoop({ idempotency_key, loop_id, number, kind, base_version, outcome, resolution = 'done' }) {
      return withIdem(idempotency_key, () => {
        if (!outcome || !String(outcome).trim()) {
          const error = new Error('fixture close-loop refused: outcome_required');
          error.payload = { error: 'outcome_required', hint: 'Say what happened before closing the record.' };
          throw error;
        }
        const found = findLoop({ loop_id, number, kind });
        if (typeof found === 'string' || !found) {
          const error = new Error(`fixture close-loop refused: ${found || 'not_found'}`);
          error.payload = { error: typeof found === 'string' ? found : 'not_found' };
          throw error;
        }
        if (found.status !== 'open') {
          const error = new Error('fixture close-loop refused: loop_not_open');
          error.payload = { error: 'loop_not_open' };
          throw error;
        }
        guardVersion(found, base_version);
        found.status = resolution === 'dropped' ? 'dropped' : 'done';
        found.close_outcome = String(outcome).trim();
        found.closed_at = nowIso();
        found.version = Number(found.version) + 1;
        found.updated_at = found.closed_at;
        return { ok: true, loop_id: found.loop_id, number: found.number, status: found.status };
      });
    },

    async engineeringPassport({ work_request } = {}) {
      const row = workRequestOrRefuse('engineering-passport', work_request);
      if (!row.passport) refuse('engineering-passport', 'engineering_work_request_not_found', { work_request });
      return structuredClone(row.passport);
    },

    async readPortfolio({ portfolio_ref } = {}) {
      const row = portfolios.get(String(portfolio_ref));
      if (!row) refuse('read-portfolio', 'portfolio_readback_unavailable', { portfolio_ref });
      return { ok: true, ...structuredClone(row) };
    },

    async workRequestCard({ work_request } = {}) {
      const enriched = sharedRequestCards.get(String(work_request));
      if (enriched) return structuredClone(enriched);
      const row = workRequestOrRefuse('work-request-card', work_request);
      return {
        ok: true, human_ref: row.ref, title: row.title, state: row.state, version: Number(row.version),
        projection_state: ['declined', 'superseded'].includes(row.state) ? 'declined' : 'queued',
        shape: row.shape ? { ...row.shape } : null,
        withdrawal: row.withdrawal ? { ...row.withdrawal } : null,
        next_human_action: { label: 'Review and triage', effect: 'none' },
        actions: [],
      };
    },

    // Triage updates sharedRequestCards and sharedRequests together; these rows are absent from workRequests.
    async answerWorkRequestForJoe({ idempotency_key, human_ref, base_version, answer_text, scope_confirmed, evidence_ref } = {}) {
      return withIdem(idempotency_key, () => {
        const ref = String(human_ref ?? '');
        const card = sharedRequestCards.get(ref);
        const listed = sharedRequests.find((row) => row.human_ref === ref);
        if (!card || !listed || card.state !== 'needs_joe') {
          refuse('answer-work-request-for-joe', 'work_request_not_found', { human_ref: ref });
        }
        if (!Number.isInteger(base_version)) {
          refuse('answer-work-request-for-joe', 'missing_base_version', { hint: 'Re-read the Work Request card and send the version it holds now.' });
        }
        if (Number(base_version) !== Number(card.version)) {
          refuse('answer-work-request-for-joe', VERSION_CONFLICT, { human_ref: card.human_ref, resolution: 're-read the Work Request card; only its current version may be answered' });
        }
        if (scope_confirmed !== true) refuse('answer-work-request-for-joe', 'scope_not_confirmed', { human_ref: ref });
        const text = String(answer_text ?? '').trim();
        if (!text || text.length > 500) refuse('answer-work-request-for-joe', 'answer_text_invalid', { human_ref: ref });
        const evidence = evidence_ref === undefined || evidence_ref === null ? '' : String(evidence_ref).trim();
        if (evidence.length > 500) refuse('answer-work-request-for-joe', 'evidence_ref_invalid', { human_ref: ref });
        card.state = 'triaged';
        card.version = Number(card.version) + 1;
        card.answer_text = text;
        card.scope_confirmed = true;
        card.evidence_ref = evidence.length ? evidence : null;
        card.answered_by_actor_slug = selfActor;
        card.answered_at = nowIso();
        card.next_human_action = { label: 'Review the triaged answer', effect: 'none' };
        listed.state = 'triaged';
        listed.next_human_action = 'Review the triaged answer';
        return {
          ok: true, human_ref: card.human_ref, state: card.state, version: card.version,
          answer_text: card.answer_text, evidence_ref: card.evidence_ref,
          answered_by_actor_slug: card.answered_by_actor_slug, answered_at: card.answered_at,
        };
      });
    },

    async declineWorkRequest({ idempotency_key, human_ref, base_version, exit_reason }) {
      return withIdem(idempotency_key, () => {
        const row = workRequestOrRefuse('decline-work-request', human_ref);
        if (row.state !== 'captured') refuse('decline-work-request', 'work_request_not_found', { human_ref });
        guardWorkRequestVersion('decline-work-request', row, base_version);
        if (!exit_reason || !String(exit_reason).trim()) refuse('decline-work-request', 'exit_reason_required', { hint: 'Say why this request was captured in error.' });
        row.state = 'declined';
        row.version = Number(row.version) + 1;
        row.withdrawal = { exit_reason: String(exit_reason).trim(), closed_at: nowIso(), superseded_by_ref: null };
        return { ok: true, human_ref: row.ref, state: row.state, version: row.version, exit_reason: row.withdrawal.exit_reason, closed_at: row.withdrawal.closed_at };
      });
    },

    async supersedeWorkRequest({ idempotency_key, human_ref, base_version, exit_reason, superseded_by }) {
      return withIdem(idempotency_key, () => {
        const row = workRequestOrRefuse('supersede-work-request', human_ref);
        if (row.state !== 'captured') refuse('supersede-work-request', 'work_request_not_found', { human_ref });
        guardWorkRequestVersion('supersede-work-request', row, base_version);
        if (!/^WR-[0-9]{1,12}$/.test(String(superseded_by))) refuse('supersede-work-request', 'successor_required', { hint: 'Name the request that replaces this one.' });
        row.state = 'superseded';
        row.version = Number(row.version) + 1;
        row.withdrawal = { exit_reason: String(exit_reason).trim(), closed_at: nowIso(), superseded_by_ref: String(superseded_by) };
        return { ok: true, human_ref: row.ref, state: row.state, version: row.version, exit_reason: row.withdrawal.exit_reason, closed_at: row.withdrawal.closed_at, superseded_by_ref: row.withdrawal.superseded_by_ref };
      });
    },

    async setWorkShapeDisposition({ idempotency_key, work_request, base_version, disposition, rationale, fixed_surface_ref, human_quote }) {
      return withIdem(idempotency_key, () => {
        const row = workRequestOrRefuse('set-work-shape-disposition', work_request);
        if (!['captured', 'triaged', 'ready'].includes(row.state)) {
          refuse('set-work-shape-disposition', 'work_shape_disposition_frozen', { work_request: row.ref, state: row.state, allowed_states: ['captured', 'triaged', 'ready'] });
        }
        guardWorkRequestVersion('set-work-shape-disposition', row, base_version);
        if (!['required', 'not_required'].includes(disposition)) refuse('set-work-shape-disposition', 'invalid_disposition', {});
        if (disposition === 'not_required' && !String(fixed_surface_ref || '').trim()) {
          refuse('set-work-shape-disposition', 'fixed_surface_ref_required', { hint: 'Not required is admitted only when the surface is already fixed.' });
        }
        row.version = Number(row.version) + 1;
        row.shape = { disposition, fixed_surface_ref: disposition === 'not_required' ? String(fixed_surface_ref).trim() : null };
        void human_quote;
        return { ok: true, work_request: { id: `fixture-${row.ref}`, ref: row.ref, title: row.title, state: row.state, version: row.version,
          shape_disposition: row.shape.disposition, shape_fixed_surface_ref: row.shape.fixed_surface_ref,
          shape_rationale: String(rationale).trim(), shape_decided_by_actor_id: selfActor, shape_decided_at: nowIso() } };
      });
    },

    async incidentBoard({ state = 'open', severity = null } = {}) {
      refuseIfOutage('incidents', 'incident-board');
      const rows = incidents
        .filter((row) => (state === 'any' ? true : state === 'open' ? !['resolved', 'reviewed'].includes(row.state) : row.state === state))
        .filter((row) => (severity ? row.severity === severity : true))
        .sort((a, b) => a.severity.localeCompare(b.severity) || a.detected_at.localeCompare(b.detected_at));
      const tally = (key) => rows.reduce((out, row) => ({ ...out, [row[key]]: (out[row[key]] || 0) + 1 }), {});
      return {
        count: rows.length,
        by_severity: tally('severity'),
        by_state: tally('state'),
        ready_to_close: rows.filter((row) => row.ready_to_close).length,
        incidents: rows.map((row) => ({ ...row })),
      };
    },

    // Keep incident facts separate from hypotheses; unknown refs refuse with incident_not_found.
    async getIncident({ ref, fact_limit = 50 } = {}) {
      refuseIfOutage('incidents', 'get-incident');
      const row = incidents.find((candidate) => candidate.ref === String(ref));
      const detail = incidentDetails.get(String(ref));
      if (!row || !detail) refuse('get-incident', 'incident_not_found', { incident_ref: ref });
      return {
        ok: true,
        incident: { ...row },
        facts: detail.facts.slice(0, Number.isInteger(fact_limit) ? fact_limit : 50).map((fact) => ({ ...fact })),
        hypotheses: detail.hypotheses.map((hypothesis) => ({ ...hypothesis })),
        occurrences: detail.occurrences.map((occurrence) => ({ ...occurrence })),
        links: detail.links.map((link) => ({ ...link })),
        // Older incident fixtures may lack services and trace; absence means no recorded evidence.
        services: (detail.services || []).map((service) => ({ ...service })),
        trace: (detail.trace || []).map((step) => ({ ...step })),
      };
    },

    async linkIncidentWorkRequest({ idempotency_key, incident_ref, work_request }) {
      return withIdem(idempotency_key, () => {
        if (!/^INC-[0-9]{8}-[0-9]{2}$/.test(String(incident_ref))) refuse('link-incident-work-request', 'invalid_incident_ref', { incident_ref });
        if (!/^WR-[0-9]{1,12}$/.test(String(work_request))) refuse('link-incident-work-request', 'invalid_work_request', { work_request });
        const detail = incidentDetails.get(String(incident_ref));
        if (!detail) refuse('link-incident-work-request', 'incident_not_found', { incident_ref });
        if (detail.links.some((link) => link.ref === String(work_request))) {
          refuse('link-incident-work-request', 'already_linked', { incident_ref, work_request });
        }
        detail.links.push({ kind: 'work_request', ref: String(work_request), label: `Linked work request ${work_request}` });
        return { ok: true, incident_ref: String(incident_ref), work_request: String(work_request), links: detail.links.length };
      });
    },

    // The authenticated caller selects the feed. unread_count covers all rows, not the limited page.
    async notificationFeed({ after = null, limit = 50 } = {}) {
      refuseIfOutage('notifications', 'notification-feed');
      const capped = clampLimit(limit);
      const rows = notifications
        .filter((row) => (after ? String(row.created_at) > String(after) : true))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, capped);
      // quiet_now and quiet_suppressed are output-only; suppression includes quiet hours OR a recorded push.
      const quiet = quietNow();
      return {
        ok: true,
        unread_count: notifications.filter((row) => !row.read_at).length,
        quiet_now: quiet,
        notifications: rows.map((row) => ({
          ...row,
          delivery: row.delivery.map((entry) => ({ ...entry })),
          quiet_suppressed: quiet || row.delivery.some((entry) => entry.state === 'suppressed_quiet_hours'),
        })),
      };
    },

    // Scenario totals are independent of the page limit.
    async sessionIdentity({ query = null, limit = null, include_closed = false } = {}) {
      refuseIfOutage('sessions', 'read-session-identity');
      const text = typeof query === 'string' ? query.trim().toLowerCase() : '';
      // No fixture session is closed.
      void include_closed;
      const {EXAMPLE_SESSION_ROWS, BRANCH_SESSION_ROWS} = await import('./example-sessions.js');
      const rows = [...EXAMPLE_SESSION_ROWS, ...BRANCH_SESSION_ROWS];
      const matched = text.length === 0
        ? rows
        : rows.filter((row) => String(row.display_name).toLowerCase().includes(text)
          || String(row.canonical_session_id).toLowerCase().includes(text));
      if (text === 'reverent') {
        return { ok: true, permission_filtered: true, total_seen: 4, total_returned: 0, sessions: [] };
      }
      if (matched.length === 0) {
        return { ok: true, permission_filtered: false, total_seen: 0, total_returned: 0, sessions: [] };
      }
      const capped = Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : 25;
      const page = matched.slice(0, capped);
      const seen = text.length === 0 ? 603 : matched.length;
      const visible = text.length === 0 ? 124 : matched.length;
      return {
        ok: true,
        permission_filtered: text.length === 0,
        total_seen: seen,
        total_returned: visible,
        sessions: page.map((row) => ({ ...row })),
      };
    },

    async codexSessions() {
      refuseIfOutage('sessions', 'list-my-codex-sessions');
      // Captured session-identity rows are not first-hand native checkpoints.
      return { ok: true, sessions: [] };
    },

    async dispatchHistory({ session_id, cursor = null, limit = null } = {}) {
      refuseIfOutage('sessions', 'read-dispatch-history');
      void cursor;
      void limit;
      if (session_id === SESSION_WITH_DISPATCH) {
        return structuredClone(DISPATCH_WITH_EVENTS);
      }
      // Unknown IDs return the same no-spine state.
      return dispatchNoSpine(String(session_id));
    },

    // Preserve stale projected_at and live:false. model-room has no projection, matching the producer.
    async roomQueue({ room = 'partner-line' } = {}) {
      refuseIfOutage('model_room', 'read-room-queue');
      if (room !== 'partner-line') {
        // Null means never projected, not stale.
        return { ok: true, room: String(room), events: [], projected_at: null, live: false };
      }
      return {
        ok: true,
        room: 'partner-line',
        events: structuredClone(QUEUE_EVENTS),
        projected_at: '2026-09-01T04:08:19.914333+00:00',
        live: false,
      };
    },

    async roomTurns({ room = 'model-room', after_seq = null, limit = null } = {}) {
      refuseIfOutage('model_room', 'read-room');
      void after_seq;
      const capped = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 50;
      const turns = ROOM_TURNS.slice(0, capped).map((turn) => ({ ...turn }));
      return {
        ok: true,
        room: String(room),
        turns,
        // The producer serializes bigint sequences as strings.
        latest_seq: turns.length ? String(turns[turns.length - 1].seq) : '0',
        more: turns.length === capped,
      };
    },

    // Match add-room-turn refusals. Only seat is caller-selected; sponsor and origin are derived.
    async addRoomTurn({ idempotency_key, body, seat, room, kind = 'turn', msg_id } = {}) {
      refuseIfOutage('model_room', 'add-room-turn');
      return withIdem(idempotency_key, () => {
        const seatSlug = String(seat ?? '').trim().toLowerCase();
        if (!/^[a-z][a-z0-9_]*$/.test(seatSlug)) refuse('add-room-turn', 'seat_invalid');
        const roomName = typeof room === 'string' && room.trim() ? room.trim() : 'partner-line';
        const kindValue = ['turn', 'system', 'receipt'].includes(kind) ? kind : 'turn';
        const text = typeof body === 'string' ? body : '';
        if (!text.trim()) refuse('add-room-turn', 'body_required');
        if (text.length > 20000) refuse('add-room-turn', 'body_too_long', { limit: 20000, got: text.length });
        const last = ROOM_TURNS[ROOM_TURNS.length - 1];
        const seq = String(Number(last?.seq ?? 0) + 1);
        const at = nowIso();
        const mintedMsgId = msg_id ? String(msg_id) : `fixture-turn-${seq}`;
        // Only landed in the visible window when it targets the room this tab
        // actually reads (model-room). A turn posted to another room, like the
        // real handler, is written but is simply not part of this answer.
        if (roomName === 'model-room') {
          ROOM_TURNS.push({
            seq, room_id: roomName, at, sponsor: selfActor, seat: seatSlug, kind: kindValue,
            msg_id: mintedMsgId, origin_channel: 'mcp', origin_actor: selfActor, body: text,
          });
        }
        return {
          ok: true, room: roomName, seq, at, sponsor: selfActor, seat: seatSlug,
          kind: kindValue, origin_channel: 'mcp', origin_actor: selfActor, msg_id: mintedMsgId,
        };
      });
    },

    async notificationPreferences() {
      refuseIfOutage('notifications', 'read-notification-preferences');
      return { ...preferencePayload(), quiet_now: quietNow() };
    },

    // Apply 0527 refusals in order before mutation, then compare-and-swap with current_version on conflict.
    async setNotificationPreference({
      idempotency_key, base_version, device_opt_in,
      quiet_hours_start, quiet_hours_end, timezone, clear_quiet_hours,
    }) {
      refuseIfOutage('notifications', 'set-notification-preference');
      return withIdem(idempotency_key, () => {
        const clear = clear_quiet_hours === true;
        if (clear && (quiet_hours_start != null || quiet_hours_end != null)) {
          refuse('set-notification-preference', 'notification_preference_quiet_hours_conflicting_request');
        }
        for (const value of [quiet_hours_start, quiet_hours_end]) {
          if (value != null && !PREF_CLOCK.test(String(value))) {
            refuse('set-notification-preference', 'notification_preference_quiet_hours_incomplete');
          }
        }
        if (!clear) {
          // The store coalesces each side over the row it already holds, so a
          // half pair is only incomplete when the OTHER side is still absent.
          const start = quiet_hours_start ?? preference.quiet_hours_start;
          const end = quiet_hours_end ?? preference.quiet_hours_end;
          if ((start == null) !== (end == null)) {
            refuse('set-notification-preference', 'notification_preference_quiet_hours_incomplete');
          }
        }
        if (timezone != null && !knownTimezone(timezone)) {
          refuse('set-notification-preference', 'notification_preference_timezone_unknown', { timezone });
        }
        if (!Number.isInteger(base_version) || base_version !== preference.version) {
          refuse('set-notification-preference', VERSION_CONFLICT, { current_version: preference.version });
        }
        if (typeof device_opt_in === 'boolean') preference.device_opt_in = device_opt_in;
        if (clear) {
          preference.quiet_hours_start = null;
          preference.quiet_hours_end = null;
        } else {
          if (quiet_hours_start != null) preference.quiet_hours_start = String(quiet_hours_start);
          if (quiet_hours_end != null) preference.quiet_hours_end = String(quiet_hours_end);
        }
        if (timezone != null) preference.timezone = String(timezone);
        preference.exists = true;
        preference.version += 1;
        return { ...preferencePayload(), deduplicated: false };
      });
    },

    // Malformed and foreign IDs both refuse notification_not_found. Repeated ack retains the first read_at.
    async acknowledgeNotification({ idempotency_key, notification_id }) {
      return withIdem(idempotency_key, () => {
        const id = String(notification_id || '');
        const row = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
          ? notifications.find((candidate) => candidate.id === id)
          : null;
        if (!row) refuse('acknowledge-notification', 'notification_not_found', { notification_id });
        if (row.read_at) return { ok: true, notification_id: row.id, read_at: row.read_at, deduplicated: true };
        row.read_at = nowIso();
        return { ok: true, notification_id: row.id, read_at: row.read_at, deduplicated: false };
      });
    },

    // Read misses share one refusal. Rename checks creator before version. Create uses the idempotency key as ID.
    async readDocConversation({ conversation_id, after_sequence = null, limit = 50 } = {}) {
      refuseIfOutage('conversations', 'read-doc-conversation');
      const id = String(conversation_id || '');
      const row = DOC_UUID.test(id) ? docConversations.get(id) : null;
      if (!row || !docVisibleTo(row, selfActor)) refuse('read-doc-conversation', 'doc_conversation_not_found');
      // Match 0520:181-198 clamps and inclusive sequence >= after_sequence paging.
      const capped = Math.min(200, Math.max(1, Number.isInteger(limit) ? limit : 200));
      const after = Math.max(0, Number.isInteger(after_sequence) ? after_sequence : 0);
      const eligible = row.turns.filter((turn) => turn.sequence >= after);
      const page = eligible.slice(0, capped);
      return {
        ok: true,
        identity: {
          id: row.id, title: row.title, visibility: row.visibility,
          pinned_at: row.pinned_at, archived_at: row.archived_at,
          version: row.version, created_by: row.created_by,
        },
        turns: page.map((turn) => ({ ...turn })),
        latest_sequence: row.turns.length ? row.turns[row.turns.length - 1].sequence : -1,
        // 0520:202-204 verbatim: `exists sequence >= v_after + count(returned)`.
        more: row.turns.some((turn) => turn.sequence >= after + page.length),
        effective_grants: docLiveGrants(row).map((grant) => ({
          grantee_actor: grant.grantee_actor, granted_at: grant.granted_at, granted_by_actor: grant.granted_by_actor,
        })),
        visible_conversation_count: docVisibleCount(selfActor),
      };
    },

    /**
     * `list-doc-conversations` (WR-000115, registry v32). A READ that names no
     * actor: the acting actor is derived by the record layer, so this fixture
     * derives it from `selfActor` and accepts no actor argument at all — an
     * argument the verb's `additionalProperties:false` schema would reject.
     *
     * The order is the store's: PINNED FIRST, then most recently updated. It is
     * produced here rather than left to the caller precisely so a client that
     * re-sorted would be caught by a test.
     */
    async listDocConversations({ cursor = null, limit = null, include_archived = null } = {}) {
      refuseIfOutage('conversations', 'list-doc-conversations');
      const capped = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 25));
      const visible = [...docConversations.values()].filter((row) => docVisibleTo(row, selfActor));
      const eligible = include_archived === true ? visible : visible.filter((row) => !row.archived_at);
      const updatedAt = (row) => (row.turns.length ? row.turns[row.turns.length - 1].at : '');
      const ordered = [...eligible].sort((a, b) => {
        if (Boolean(a.pinned_at) !== Boolean(b.pinned_at)) return a.pinned_at ? -1 : 1;
        const byClock = String(updatedAt(b)).localeCompare(String(updatedAt(a)));
        return byClock !== 0 ? byClock : String(a.id).localeCompare(String(b.id));
      });
      // The cursor is OPAQUE to the caller. Here it is the id of the row the
      // next page starts at, encoded, so a client that tried to read or build
      // one would be reading a shape it was never given.
      let offset = 0;
      if (cursor !== null && cursor !== undefined && cursor !== '') {
        let decoded = null;
        try { decoded = JSON.parse(atob(String(cursor))); } catch { decoded = null; }
        const at = decoded && ordered.findIndex((row) => row.id === decoded.after);
        if (!decoded || at === undefined || at < 0) refuse('list-doc-conversations', 'doc_conversation_cursor_invalid', { cursor });
        offset = at + 1;
      }
      const page = ordered.slice(offset, offset + capped);
      const more = offset + page.length < ordered.length;
      return {
        ok: true,
        conversations: page.map((row) => ({
          id: row.id, title: row.title, visibility: row.visibility,
          pinned_at: row.pinned_at, archived_at: row.archived_at,
          version: row.version, created_by: row.created_by,
          latest_sequence: row.turns.length ? row.turns[row.turns.length - 1].sequence : -1,
          latest_turn_at: row.turns.length ? row.turns[row.turns.length - 1].at : null,
        })),
        more,
        next_cursor: more ? btoa(JSON.stringify({ after: page[page.length - 1].id })) : null,
        visible_conversation_count: docVisibleCount(selfActor),
      };
    },

    async listDocSuggestions({ conversation_id = null, include_parked = false } = {}) {
      refuseIfOutage('conversations', 'list-doc-suggestions');
      const conversation = conversation_id ? docConversations.get(conversation_id) : null;
      if (conversation_id && !docVisibleTo(conversation, selfActor))
        refuse('list-doc-suggestions', 'doc_conversation_not_found');
      const suggestions = [...docSuggestions.values()].filter(row =>
        (!conversation_id || row.conversation_id === conversation_id)
        && docVisibleTo(docConversations.get(row.conversation_id), selfActor)
        && (include_parked || !['snoozed','dismissed'].includes(row.disposition)
          || row.material_version !== (row.disposition === 'snoozed' ? row.snoozed_material_version : row.dismissed_material_version)));
      const coverage = conversation_id
        ? { state: 'unknown', latest_sequence: conversation.turns.at(-1)?.sequence ?? -1,
          scanned_through: null, empty_state: suggestions.length ? 'not_empty' : 'unknown' }
        : { state: 'unknown', reason_id: 'conversation_scope_required' };
      return { ok: true, suggestions: suggestions.map(row => ({ ...row,
        source_conversation_id: row.conversation_id,
        contributions: row.contributions.map(item => ({ ...item })),
        corrections: [...docCorrections.entries()].filter(([, item]) => item.suggestion_id === row.id)
          .map(([id, item]) => ({ id, ...item })) })), coverage, as_of: new Date().toISOString() };
    },
    async decideDocSuggestion({ suggestion_id, base_version, choice, snoozed_until = null, work_ref = null, idempotency_key }) {
      refuseIfOutage('conversations', 'decide-doc-suggestion');
      const row = docSuggestions.get(suggestion_id);
      if (!row || !docVisibleTo(docConversations.get(row.conversation_id), selfActor))
        refuse('decide-doc-suggestion', 'doc_suggestion_not_found');
      docGuardKey('decide-doc-suggestion', idempotency_key,
        { suggestion_id, base_version, choice, snoozed_until, work_ref });
      if (docSuggestionResults.has(idempotency_key))
        return { ...docSuggestionResults.get(idempotency_key), deduplicated: true };
      if (row.version !== base_version) refuse('decide-doc-suggestion', VERSION_CONFLICT, { current: { ...row } });
      if (!['act','discuss','snooze','dismiss'].includes(choice)) refuse('decide-doc-suggestion', 'choice_invalid');
      if (choice === 'act') {
        const found = loops.filter(item => item.number === String(work_ref || '').replace(/^#/, '')
          && item.status === 'open' && (item.tier === 'shared' || item.personal_to === selfActor));
        if (found.length !== 1) refuse('decide-doc-suggestion', found.length ? 'work_ref_ambiguous' : 'work_ref_required');
        row.work_ref = found[0].loop_id;
      }
      if (choice === 'snooze' && (!snoozed_until || snoozed_until <= new Date().toISOString().slice(0,10)))
        refuse('decide-doc-suggestion', 'future_snooze_date_required');
      row.disposition = choice === 'snooze' ? 'snoozed' : choice === 'dismiss' ? 'dismissed' : choice;
      if (choice === 'dismiss') row.dismissed_material_version = row.material_version;
      if (choice === 'snooze') { row.snoozed_material_version = row.material_version; row.snoozed_until = snoozed_until; }
      row.version += 1;
      const result = { ok: true, suggestion_id, choice, version: row.version, work_ref: row.work_ref || null };
      docSuggestionResults.set(idempotency_key, result);
      return result;
    },
    async proposeDocCorrection({ suggestion_id, base_version, proposed_text, source_conversation_id, source_sequence, idempotency_key }) {
      refuseIfOutage('conversations', 'propose-doc-correction');
      const row = docSuggestions.get(suggestion_id);
      if (!row || !docVisibleTo(docConversations.get(row.conversation_id), selfActor))
        refuse('propose-doc-correction', 'doc_suggestion_not_found');
      docGuardKey('propose-doc-correction', idempotency_key,
        { suggestion_id, base_version, proposed_text, source_conversation_id, source_sequence });
      if (docSuggestionResults.has(idempotency_key))
        return { ...docSuggestionResults.get(idempotency_key), deduplicated: true };
      if (row.version !== base_version) refuse('propose-doc-correction', VERSION_CONFLICT, { current: { ...row } });
      if (row.conversation_id !== source_conversation_id || row.source_sequence !== source_sequence)
        refuse('propose-doc-correction', 'source_scope_mismatch');
      if (!String(proposed_text || '').trim()) refuse('propose-doc-correction', 'correction_text_invalid');
      docCorrections.set(idempotency_key, { suggestion_id, base_version, proposed_text,
        source_conversation_id, source_sequence, proposed_by: selfActor, proposed_at: nowIso(), status: 'pending' });
      const result = { ok: true, proposal_id: idempotency_key, status: 'pending' };
      docSuggestionResults.set(idempotency_key, result);
      return result;
    },

    // Read-only, server-scoped cards. Outage returns 503; opaque cursors encode the next row ID.
    // session_entry.auto_launch always remains false.
    async docOutcomeCards({ cursor = null, limit = null } = {}) {
      refuseIfOutage('doc_outcome_cards', 'read-doc-outcome-cards');
      const capped = Math.min(50, Math.max(1, Number.isInteger(limit) ? limit : 25));
      let offset = 0;
      if (cursor !== null && cursor !== undefined && cursor !== '') {
        let decoded = null;
        try { decoded = JSON.parse(atob(String(cursor))); } catch { decoded = null; }
        const at = decoded && OUTCOME_CARD_ROWS.findIndex((row) => row.card_id === decoded.after);
        if (!decoded || at === undefined || at < 0) refuse('read-doc-outcome-cards', 'doc_outcome_cursor_invalid', { cursor });
        offset = at + 1;
      }
      const page = OUTCOME_CARD_ROWS.slice(offset, offset + capped);
      const more = offset + page.length < OUTCOME_CARD_ROWS.length;
      return {
        ok: true,
        schema_version: 'doc-outcome-cards.v2',
        as_of: nowIso(),
        correlation_version: 'sha256:fixture-doc-outcome-cards',
        more,
        next_cursor: more ? btoa(JSON.stringify({ after: page[page.length - 1].card_id })) : null,
        cards: page.map((row) => structuredClone(row)),
      };
    },

    // Match closed find/find-and-catch-up schemas. No matches return 200 with six empty arrays and a note.
    async find(args = {}) {
      refuseIfOutage('search', 'find');
      const keys = Object.keys(args || {});
      const extra = keys.filter((key) => key !== 'query');
      if (extra.length > 0) refuse('find', 'unregistered_operation_fields', { operation: 'find', fields: extra });
      if (!('query' in (args || {})) || args.query === undefined || args.query === null || args.query === '') {
        refuse('find', 'missing_required', { missing: ['query'], hint: 'this verb requires "query"' });
      }
      return searchFind(String(args.query));
    },

    async findAndCatchUp(args = {}) {
      refuseIfOutage('search', 'find-and-catch-up');
      const keys = Object.keys(args || {});
      const extra = keys.filter((key) => key !== 'query' && key !== 'limit');
      if (extra.length > 0) refuse('find-and-catch-up', 'unregistered_operation_fields', { operation: 'find-and-catch-up', fields: extra });
      const limit = args.limit === undefined ? 20 : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        refuse('find-and-catch-up', 'invalid_limit', { hint: 'limit must be an integer from 1 to 50' });
      }
      const query = typeof args.query === 'string' ? args.query : '';
      if (query.trim() === '' || query.length > 200) {
        refuse('find-and-catch-up', 'invalid_query', { hint: 'query must be a nonempty string of at most 200 characters' });
      }
      const payload = searchFind(query);
      const candidates = searchCandidates(payload);
      if (candidates.length === 0) {
        const retired = payload.parties.filter((row) => row.merged === true).length +
          payload.organizations.filter((row) => row.all_retired).length;
        return {
          state: 'not_found', query, candidates: [], retired_matches: retired,
          hint: retired > 0
            ? 'Only previous names matched.'
            : 'No current match.',
        };
      }
      if (candidates.length === 1) {
        const match = candidates[0];
        return {
          state: 'completed', query,
          match: { kind: match.kind, name: match.name, target: match.target },
          catch_up: {
            subject: { type: match.kind, id: `demo-${match.kind}-catch-up` },
            timeline: [{
              entry_kind: 'event', occurred_at: '2026-08-19T12:51:04.522Z', actor: 'hermes-pilot',
              verb: 'record-finding', summary: 'verified', detail: null, owed: null,
            }],
          },
        };
      }
      const shown = candidates.slice(0, Math.min(limit, SEARCH_CAPS.candidates));
      return {
        state: 'needs_disambiguation', query,
        candidate_count: candidates.length,
        candidates: shown.map((row) => ({ kind: row.kind, name: row.name, target: row.target })),
        candidates_truncated: shown.length < candidates.length,
        hint: 'Choose one exact target and call catch-me-up; this verb never guesses.',
      };
    },

    async createDocConversation({ idempotency_key, title, visibility = 'private' } = {}) {
      docGuardKey('create-doc-conversation', idempotency_key, { title, visibility });
      return withIdem(idempotency_key, () => {
        const key = String(idempotency_key || '');
        if (!DOC_UUID.test(key)) refuse('create-doc-conversation', 'doc_conversation_idempotency_key_invalid', { idempotency_key });
        const name = String(title ?? '').trim();
        if (name.length < 1 || name.length > 200) refuse('create-doc-conversation', 'doc_conversation_title_invalid', { title });
        if (visibility !== undefined && visibility !== 'private' && visibility !== 'shared') {
          refuse('create-doc-conversation', 'doc_conversation_visibility_invalid', { visibility });
        }
        const shared = visibility === 'shared';
        // Shared creation inserts only a header (0523:75-78), never a grant.
        // Reads still require creator-or-unrevoked-grant (0520:186-189). The idempotency key is the row ID.
        docConversations.set(key, docConversation({
          id: key, title: name, version: 1, created_by: selfActor, turns: [],
          visibility: shared ? 'shared' : 'private', grants: [],
        }));
        return { ok: true, conversation_id: key, title: name, visibility: shared ? 'shared' : 'private', version: 1 };
      });
    },

    async shareDocConversation({ idempotency_key, conversation_id, grantee_slug, granted } = {}) {
      docGuardKey('share-doc-conversation', idempotency_key, { conversation_id, grantee_slug, granted });
      return withIdem(idempotency_key, () => {
        const verb = 'share-doc-conversation';
        const id = String(conversation_id || '');
        if (!DOC_UUID.test(id)) refuse(verb, 'doc_conversation_id_invalid', { conversation_id });
        const slug = String(grantee_slug ?? '').trim();
        if (!slug) refuse(verb, 'doc_conversation_grantee_slug_invalid', { grantee_slug });
        const row = docConversations.get(id);
        if (!row || !docVisibleTo(row, selfActor)) refuse(verb, 'doc_conversation_not_found');
        if (row.created_by !== selfActor) refuse(verb, 'doc_conversation_creator_only', { conversation_id: id });
        if (!DOC_ACTORS.includes(slug)) refuse(verb, 'doc_conversation_grantee_not_found', { grantee_slug: slug });
        if (slug === row.created_by) refuse(verb, 'doc_conversation_grantee_is_creator', { grantee_slug: slug });
        const live = docLiveGrants(row).find((grant) => grant.grantee_actor === slug);
        // Granting twice and revoking twice are NOT refusals: the store answers
        // both with `already: true`, having written nothing the second time.
        if (granted === true) {
          if (live) return { ok: true, conversation_id: id, grantee_slug: slug, already: true, granted: true, visibility: row.visibility };
          row.grants.push({ grantee_actor: slug, granted_at: nowIso(), granted_by_actor: selfActor, revoked_at: null });
          // 0523:181-183: a grant OVERWRITES the column to 'shared'. It is not
          // recomputed, and it does not bump the version.
          row.visibility = 'shared';
          return { ok: true, conversation_id: id, grantee_slug: slug, already: false, granted: true, visibility: row.visibility };
        }
        if (!live) return { ok: true, conversation_id: id, grantee_slug: slug, already: true, granted: false, visibility: row.visibility };
        // Revoked, never deleted: the row stays and carries when it ended.
        live.revoked_at = nowIso();
        docRecomputeVisibility(row);
        return { ok: true, conversation_id: id, grantee_slug: slug, already: false, granted: false, visibility: row.visibility };
      });
    },

    async renameDocConversation({ idempotency_key, conversation_id, base_version, title, pinned, archived } = {}) {
      docGuardKey('rename-doc-conversation', idempotency_key, { conversation_id, base_version, title, pinned, archived });
      return withIdem(idempotency_key, () => {
        const verb = 'rename-doc-conversation';
        const id = String(conversation_id || '');
        if (!DOC_UUID.test(id)) refuse(verb, 'doc_conversation_id_invalid', { conversation_id });
        let name;
        if (title !== undefined) {
          name = String(title ?? '').trim();
          if (name.length < 1 || name.length > 200) refuse(verb, 'doc_conversation_title_invalid', { title });
        }
        const row = docConversations.get(id);
        if (!row || !docVisibleTo(row, selfActor)) refuse(verb, 'doc_conversation_not_found');
        // BEFORE the comparison and before any write: a non-creator's rename
        // leaves the version exactly where it was.
        if (row.created_by !== selfActor) refuse(verb, 'doc_conversation_creator_only', { conversation_id: id });
        if (name === undefined && pinned === undefined && archived === undefined) {
          refuse(verb, 'doc_conversation_no_change_requested', { conversation_id: id });
        }
        if (!Number.isInteger(base_version) || base_version !== row.version) {
          refuse(verb, VERSION_CONFLICT, { conversation_id: id, current_version: row.version });
        }
        if (name !== undefined) {
          // The PRIOR title, appended to an immutable history no verb reads back.
          docTitleRevisions.push({ conversation_id: id, title: row.title, version: row.version, recorded_at: nowIso() });
          row.title = name;
        }
        if (pinned !== undefined) row.pinned_at = pinned === true ? nowIso() : null;
        if (archived !== undefined) row.archived_at = archived === true ? nowIso() : null;
        row.version += 1;
        return {
          ok: true, conversation_id: id, version: row.version, title: row.title,
          pinned_at: row.pinned_at, archived_at: row.archived_at,
        };
      });
    },

    async currentWorkItem() {
      refuseIfOutage('work', 'current-work-item');
      const inFlight = heldWork.filter((row) => row.state === 'claimed' || row.state === 'in_progress');
      return {
        ok: true,
        current: heldWork.map((row) => ({ ...row })),
        count: heldWork.length,
        wip: {
          limit_system_wide: 2, limit_per_executor: 1, in_flight: inFlight.length,
          over_system_limit: inFlight.length > 2, executors_over_limit: [], in_flight_unattributed: 0,
          note: 'reported here, enforced in the claim path',
        },
        unchanged_over_48h: heldWork.filter((row) => row.hours_since_last_change >= 48)
          .map((row) => ({ human_ref: row.human_ref, hours_since_last_change: row.hours_since_last_change })),
        say: 'these are held right now; a blocked or needs-Joe row is still current and is never skipped',
      };
    },

    async readResourceDashboard() {
      refuseIfOutage('resources', 'read-resource-dashboard');
      return {
        ok: true, schema: 'doctorcre-resource-dashboard.v1', generated_at: nowIso(),
        providers: ['neon', 'github', 'cloudflare', 'local_compute', 'model_route'].map((provider) => ({
          provider,
          state: ['neon', 'github', 'cloudflare'].includes(provider) ? 'unconfigured' : 'collector_absent',
          reason: ['neon', 'github', 'cloudflare'].includes(provider)
            ? 'no collector configured for this provider yet (V5-UX-C03/C04/C05 not built)'
            : 'no collector observation received yet',
          account: null, project: null, product: null, period: null, as_of: null,
          quantity: null, quantity_unit: null, allowance: null, policy: null,
          estimate: null, charge: null, measured_capacity: null, configured_capacity: null,
          model_route: null, source: null, observed_at: null,
        })),
      };
    },

    async currentWorkRequests() {
      refuseIfOutage('needs_joe', 'current-work-requests');
      return { ok: true, items: sharedRequests.map((row) => ({ ...row, source: { ...row.source } })) };
    },

    // Synthetic governance-queue rows follow ops.read_governance_queue (0345).
    // Clock-relative timestamps cover under a day, over a day and past the 48-hour cadence.
    async readConnections() {
      const checked_at=nowIso();
      return {ok:true,schema:'doctorcre-connections.v1',generated_at:checked_at,providers:Object.entries(CONNECTION_NAMES).map(([id,name])=>({id,name,status:id==='grok'?'needs_reconnect':'connected',checked_at,manage_url:'/control-room?tab=connections',spend:{amount:12.34,currency:'USD',kind:id==='jev'?'estimate':'charge',period:'October 2026',as_of:checked_at}})),devices:{state:'read',observed_at:checked_at,items:[{id:'demo-laptop',name:'Demo laptop',connected:true},{id:'demo-workstation',name:'Demo workstation',connected:false}]}};
    },
    async listProgressBoards(){return {schema:'progress-board-directory.v1',boards:[{board_id:'carr-v5',title:'System Job Board',updated_at:nowIso(),task_counts:{running:1}}]};},
    async readProgressBoard({board_id}={}){return {ok:true,snapshot:{board_id,version:1,updated_at:nowIso(),snapshot_json:{title:'System Job Board',tasks:{}}},questions:[]};},
    // Synthetic work-queue rows: one demo job per derived stage, shaped like the work-queue verb.
    async workQueue(){
      const job=(slice,j,stage,title,prs=[],extra={})=>({card_id:`WR901.S${slice}.J${j}`,work_request:'WR-000901',work_request_title:'Demo dashboard refresh',slice_ordinal:slice,j_number:j,priority:slice*10+j,executor:'codex',model:'demo-model',effort:'medium',card_title:title,description:`Demo ${title.toLowerCase()} work.`,created_at:nowIso(),stage,stale:false,prs,...extra});
      const pr=(n,state,draft=false)=>({repo:'jbookout/doctorcre-app',number:n,url:`https://github.com/jbookout/doctorcre-app/pull/${n}`,title:`Demo PR ${n}`,draft,state,updated_at:nowIso(),card_id:`WR901.S1.J${n-100}.app#${n}`});
      return {ok:true,stale_after_hours:24,github:[{repo:'jbookout/doctorcre-app',state:'ok',observed_at:nowIso(),truncated:false}],jobs:[
        job(1,1,'review','Demo chart fix',[pr(101,'open')]),job(1,2,'build','Demo table work',[pr(102,'open',true)]),
        job(1,3,'merged','Demo copy update',[pr(103,'merged')]),job(1,4,'closed','Demo retired idea',[pr(104,'closed')]),
        job(2,1,'queued','Demo export check',[],{stale:true})]};
    },
    // V2 C1: one demo row per unfinished-work kind the live census returns,
    // plus a captured Work Request and a detected incident for Triage. Shapes
    // follow unfinished-work.v1 (mcp-server/src/system-work-census.v5.js);
    // every title says Demo and every id is invented. WR-000901 stays first.
    async unfinishedWork({live_library=false,limit=100,cursor=null}={}){
      if(live_library)return {schema:'unfinished-work.v1',items:[],coverage:[],census_complete:true,as_of:nowIso(),next_cursor:null};
      const at=nowIso(),row=(kind,id,state,title,extra={})=>({id,kind,state,status:state,title,source:`demo.${kind}`,source_ref:`demo.${kind}`,opened_at:at,last_activity_at:at,age:0,owner:'Demo builder',version:'1',link:null,identity:{},available_triage_actions:[],completed:false,cancelled:false,...extra});
      const close=[{action:'cancel',verb:'close-loop',args:{},fields:[{name:'outcome'}],versioned:true}];
      const rows=[
        row('work_request','WR-000901','verification','Demo dashboard refresh',{human_ref:'WR-000901',identity:{human_ref:'WR-000901'},pr:17}),
        row('work_request','WR-000910','in_progress','Demo lease abstract importer',{identity:{human_ref:'WR-000910'},owner:'claude',age:9}),
        row('work_request','WR-000911','blocked','Demo vendor merge waits on a name decision',{identity:{human_ref:'WR-000911'},owner:'joe',age:10}),
        row('incident','INC-20260915-01','investigating','Demo export service stopped writing its nightly generation',{identity:{ref:'INC-20260915-01'},owner:'joe',version:null,age:4}),
        row('defect','0d3f6c2a-0000-4000-8000-00000000d001','fix_untracked','Demo tour PDF drops the last stop',{identity:{defect_id:'0d3f6c2a-0000-4000-8000-00000000d001'},owner:null,version:null,age:12}),
        row('loop','loop-006','open','Demo tenant-rep packet: regenerate the market comparison',{identity:{kind:'open_loop',loop_id:'loop-006'},owner:'claude',available_triage_actions:close,age:5}),
        row('work_shape','5e6f7a8b-0000-4000-8000-00000000b001','ready','Demo shape for the notes export',{identity:{work_request:'WR-000912'},age:1}),
        row('builder_brief','5e6f7a8b-0000-4000-8000-00000000b002','triaged','Demo brief for the map legend',{identity:{work_request:'WR-000913'},age:1}),
        row('slice_plan','9c8d7e6f-0000-4000-8000-00000000c001','blocked','Demo slice plan waiting on review capacity',{identity:{work_request:'WR-000914'},age:6}),
        row('capability_session','2b3c4d5e-0000-4000-8000-00000000e001','claimed','Demo capability session for doc search',{identity:{sequence:2},age:0}),
        row('retrieval_proposal','3c4d5e6f-0000-4000-8000-00000000f001','pending','Demo retrieval phrase for lease options',{owner:null,age:4}),
        row('work_request','WR-000920','captured','Demo capture: Today panel shows raw timestamps',{identity:{human_ref:'WR-000920'},available_triage_actions:[{action:'progress',verb:'review-and-triage',args:{},fields:[],versioned:true}],owner:null}),
        row('incident','INC-20261018-02','detected','Demo detected: notes canary missed a beat',{identity:{ref:'INC-20261018-02'},version:null,available_triage_actions:[{action:'progress',verb:'triage-incident',args:{},fields:[],versioned:false}],owner:null}),
      ];
      const start=Number.parseInt(cursor||'0',10)||0,size=Math.max(1,Math.min(500,Number(limit)||100)),items=rows.slice(start,start+size),next=start+size<rows.length?String(start+size):null;
      const coverage=[...new Set(rows.map(r=>r.kind))].map(kind=>({kind,source_ref:`demo.${kind}`,state:kind==='defect'?'partial':'complete',count_total:rows.filter(r=>r.kind===kind).length,count_returned:items.filter(r=>r.kind===kind).length,reason:kind==='defect'?'fix_status_not_recorded':null}));
      return {schema:'unfinished-work.v1',items,coverage,census_complete:false,as_of:at,next_cursor:next,limit:size};
    },
    async adoptRule(args) {
      const previous = conventionReceipts.get(args.idempotency_key);
      if (previous) {
        if (JSON.stringify(previous.args) !== JSON.stringify(args))
          throw Object.assign(new Error('key_reuse'), { payload: { error: 'key_reuse' } });
        return structuredClone(previous.result);
      }
      const index = conventionProposals.findIndex(row => row.section_id === args.section_id);
      const error = index < 0 ? 'convention_proposal_not_found'
        : conventionProposals[index].base_version !== args.base_version ? 'version_conflict'
          : !args.reason?.trim() ? 'missing_required' : null;
      if (error) throw Object.assign(new Error(error), { payload: { error } });
      const result = { ok: true, rule_id: uuidv4(), retired_section_id: args.section_id };
      conventionProposals.splice(index, 1);
      conventionReceipts.set(args.idempotency_key, { args: structuredClone(args), result });
      return structuredClone(result);
    },
    async governanceQueue() {
      refuseIfOutage('approvals', 'governance-queue');
      const ago = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
      const rules = [
        { rule_id: 'd0000000-0000-4000-8000-00000000c141', statement: 'Demo rule: a demo surface marks unavailable information.', human_quote: 'demo partner words about honest zeros', scope: 'demo', taught_at: ago(74), enforcement_class: 'demo_hook', binding_moment: 'before a demo surface ships', admission_reason: 'Demo admission: enforcement checked against the demo fixture', enforcement_status: 'checked', fixture_refs: [], admitted_at: ago(72) },
      ];
      const batches = [
        { batch_id: 'd0000000-0000-4000-8000-00000000c142', manifest_digest: `sha256:${'d'.repeat(64)}`, reason: 'Demo guidance import: three demo leasing notes', staging_key: 'demo-leasing-notes', staged_at: ago(30), entry_count: 3 },
      ];
      const proposals = [
        { proposal_id: 'd0000000-0000-4000-8000-00000000c143', proposal_type: 'phrase', payload: { phrase: 'demo phrase' }, reason: 'Demo retrieval phrase for the demo vendor list', proposer_actor_id: 'joe', version: 1, proposed_at: ago(5) },
        { proposal_id: 'd0000000-0000-4000-8000-00000000c144', proposal_type: 'concept', payload: {}, reason: null, proposer_actor_id: 'dell', version: 1, proposed_at: ago(2) },
      ];
      return {
        ok: true,
        pending_convention_proposals: structuredClone(conventionProposals),
        pending_rule_approvals: rules,
        pending_guidance_import_batches: batches,
        pending_retrieval_proposals: proposals,
        counts: {
          pending_convention_proposals: conventionProposals.length,
          pending_rule_approvals: rules.length,
          pending_guidance_import_batches: batches.length,
          pending_retrieval_proposals: proposals.length,
          total: conventionProposals.length + rules.length + batches.length + proposals.length,
        },
      };
    },

    async scheduleBoard() {
      refuseIfOutage('schedule', 'schedule-board');
      const now = Date.now();
      const at = (hours) => new Date(now - hours * 3_600_000).toISOString();
      const jobs = [
        {
          key: 'demo-nightly', name: 'Demo nightly record', owner: 'launchd',
          state: 'missed', freshness: 'stale', schedule: 'Every 24 hours',
          last_run: { state: 'succeeded', at: at(54), receipt_ref: 'demo:run-nightly' },
          next_due_at: at(30), next_due_basis: 'cadence_deadline',
          actions: { pause: false, run: false, stop: false },
        },
        {
          key: 'demo-paused', name: 'Demo paused review', owner: 'claude-code',
          state: 'paused', freshness: 'fresh', schedule: 'Every 168 hours',
          last_run: { state: 'succeeded', at: at(120), receipt_ref: 'demo:run-paused' },
          next_due_at: null, next_due_basis: null,
          actions: { pause: false, run: false, stop: false },
        },
      ];
      return { ok: true, schema: 'schedule-board/v1', observed_at: new Date(now).toISOString(),
        overall_state: 'attention',
        sources: [
          { owner: 'launchd', state: 'read', count: 1 },
          { owner: 'claude-code', state: 'read', count: 1 },
          { owner: 'cron', state: 'unknown', count: null },
        ], jobs };
    },

    // Derive Home counts from the same fixture board. Mint timestamps with the contract
    // 120-second window so ordinary runs exercise fresh data.
    async commandCenter() {
      const now = Date.now();
      const observed_at = new Date(now).toISOString();
      const valid_until = new Date(now + 120_000).toISOString();
      const source = (name) => ({
        source: name,
        source_ref: name === 'command_center' ? 'fixture:command-center' : `fixture:${name}`,
        observed_at,
        valid_until,
        freshness: 'fresh',
        correlation_id: uuidv4(),
        safe_explanation: 'Synthetic fixture read. No production record was read.',
      });
      const active = [...deals.values()].filter((deal) => deal.operating_state === 'active');
      const mineActive = active.filter((deal) => deal.owner === selfActor);
      const teamFlagged = active.filter((deal) => deal.attention === true);
      const myFlagged = mineActive.filter((deal) => deal.attention === true);
      const needs = [
        { kind: 'team_flagged_deals', scope: 'team', count: teamFlagged.length, destination: TEAM_FLAGGED_DESTINATION },
        { kind: 'my_flagged_deals', scope: 'mine', count: myFlagged.length, destination: MY_FLAGGED_DESTINATION },
      ];
      // needs_joe_work is Joe's row and only Joe's: a viewer who is not Joe is
      // never shown work that is waiting on someone else's hands.
      if (selfActor === 'joe') needs.push({ kind: 'needs_joe_work', scope: 'mine', count: 2, destination: NEEDS_JOE_DESTINATION });
      return {
        viewer: selfActor === 'dell' ? 'dell' : 'joe',
        source: source('command_center'),
        metrics: [
          {
            scope: 'team', active_deals: active.length, flagged_deals: teamFlagged.length,
            active_destination: TEAM_ACTIVE_DESTINATION, flagged_destination: TEAM_FLAGGED_DESTINATION,
            source: source('v_deal_room_board'),
          },
          {
            scope: 'mine', active_deals: mineActive.length, flagged_deals: myFlagged.length,
            active_destination: null, flagged_destination: MY_FLAGGED_DESTINATION,
            source: source('v_deal_room_board'),
          },
        ],
        needs_you_now: needs,
        doc_at_work: [{ kind: 'active_nonhuman_work', count: 3, source: source('ops.work_request') }],
        recent_activity: [{ kind: 'changed_work', count: 5, observed_at, source: source('v_deal_room_board') }],
        this_week: [],
        recent_calls: [],
      };
    },

    async startReview({ workspace_kind, account_client_id, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const session = { session_id: `review-${reviewSeq++}`, workspace_kind,
          account_client_id: account_client_id || null, started_at: nowIso(), status: 'open', items: [] };
        reviewSessions.set(session.session_id, session);
        return { ok: true, ...session };
      });
    },

    async reviewDeal({ session_id, deal, disposition, note, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const session = reviewSessions.get(session_id);
        if (!session || session.status !== 'open') throw new Error('review session is not open');
        session.items = session.items.filter((i) => i.deal !== deal);
        session.items.push({ deal, disposition, note: note || null });
        return { ok: true, session_id, deal_id: deal, disposition };
      });
    },

    async endReview({ session_id, status = 'completed', idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const session = reviewSessions.get(session_id);
        session.status = status;
        session.ended_at = nowIso();
        lastCallAt = session.ended_at;
        return { ok: true, session_id, status,
          reviewed: session.items.filter((i) => i.disposition === 'reviewed').length,
          skipped: session.items.filter((i) => i.disposition === 'skipped').length };
      });
    },

    async setMarketAgent({ deal, agent_name, market, base_version, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const d = getDealOrThrow(deal); guardVersion(d, base_version);
        d.market_agent = agent_name; if (market) d.market = market; d.version += 1;
        return { ok: true, deal_id: deal, market_agent: agent_name };
      });
    },

    async setNationalAccountOwner({ account_client_id, owner, base_version, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        guardVersion({ version: fixtureAccountVersion }, base_version);
        fixtureAccountOwner = owner;
        fixtureAccountVersion += 1;
        for (const d of deals.values()) if (d.account_client_id === account_client_id) d.account_owner = owner;
        return { ok: true, account_client_id, owner };
      });
    },

    async createNationalAccount({ name, owner, idempotency_key }) {
      return withIdem(idempotency_key, () => ({ ok: true,
        account_client_id: `acct-${name.toLowerCase().replace(/\W+/g,'-')}`,
        account_client_ref: 'C-demo', name, owner }));
    },

    async createNationalMarketDeal(args) {
      const result = await client.createDeal({ name: args.deal_name, client: args.client_name,
        deal_type: args.deal_type || 'Startup', phase: args.phase || 'On Deck',
        segment: args.segment, market: args.market, lane: 'national',
        idempotency_key: args.idempotency_key });
      return { ok:true, deal_id:result.deal.id, client_ref:result.deal.client_ref,
        account_client_id:result.deal.account_client_id };
    },

    // Revert requires the latest event for a BASED_FIELDS cell; otherwise refuse event_not_revertible
    // or newer_change_exists. Append a correction event and advance lastFieldEvent, preserving history.
    async revertDealField({ event_id, idempotency_key }) {
      if (activityFixture.owns(event_id)) return activityFixture.undo({ event_id, idempotency_key });
      return withIdem(idempotency_key, () => {
        const event = events.find((e) => e.id === event_id);
        if (!event || event.subject_type !== 'deal' || !event.field || !BASED_FIELDS.includes(event.field)) {
          const error = new Error('fixture revert-deal-field refused: event_not_revertible');
          error.payload = { error: 'event_not_revertible', hint: 'The server does not undo this kind of change.' };
          throw error;
        }
        const latestId = lastFieldEvent.get(`${event.subject_id}|${event.field}`) || null;
        if (latestId !== event.id) {
          const error = new Error('fixture revert-deal-field refused: newer_change_exists');
          error.payload = { error: 'newer_change_exists', hint: 'Open the deal and review the newer value before changing it.' };
          throw error;
        }
        const d = getDealOrThrow(event.subject_id);
        if (event.field === 'operating_state') {
          const prior = event.old_value;
          d.operating_state = prior.state;
          d.parking_reason = prior.reason || null;
          d.parking_note = prior.note || null;
          d.parked_at = prior.state === 'parked' ? nowIso() : null;
          d.parked_by = prior.state === 'parked' ? selfActor : null;
        } else d[event.field] = event.old_value;
        const applied = pushEvent({
          actor: selfActor,
          verb: 'revert-deal-field',
          subject_id: d.id,
          field: event.field,
          old_value: event.new_value,
          new_value: event.old_value,
        });
        return {
          ok: true, deal_id: d.id, field: event.field, reverted_event_id: event.id,
          old_value: event.new_value, new_value: event.old_value,
          event_id: applied.id, event_recorded_at: applied.recorded_at,
        };
      });
    },

    async readDocActivity(args = {}) { return activityFixture.read(args); },

    async getPendingConfirms() {
      return { proposals: pendingConfirms.map((p) => ({ ...p })) };
    },

    async getCallContext({ deal_ids }) {
      const wanted = new Set(deal_ids || []);
      return { deals: [...deals.values()]
        .filter((deal) => wanted.has(deal.id) && (deal.operating_state || 'active') === 'active')
        .map((deal) => ({ id: deal.id, name: deal.name, owner: deal.owner || null,
          operating_state: 'active', participants: [] })) };
    },

    async resolvePostCallCandidate({ candidate_id, accept, idempotency_key }) {
      return client.resolveConfirm({ proposal_id:candidate_id, accept, idempotency_key });
    },

    async readCallOutcomes() {
      return { schema_version: 'call-outcomes.v1', send: false,
        calls: callOutcomes.filter(call => !call.reviewed).map(call => structuredClone(call)) };
    },

    async undoCallChange({ candidate_id }) {
      const change = callOutcomes.flatMap(call => call.applied).find(item => item.candidate_id === candidate_id);
      if (!change) throw Object.assign(new Error('Unknown call change.'), { payload: { error: 'not_found' } });
      change.undone_at ||= new Date().toISOString();
      return { ok: true, candidate_id, undone: true };
    },

    async reviewCallOutcome({ session_id }) {
      const call = callOutcomes.find(item => item.session_id === session_id);
      if (call) call.reviewed = true;
      return { ok: true, session_id, reviewed: true };
    },

    async resolveConfirm({ proposal_id, accept, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const idx = pendingConfirms.findIndex((p) => p.id === proposal_id);
        if (idx < 0) return { status: 'ok', event: null };
        const p = pendingConfirms[idx];
        pendingConfirms.splice(idx, 1);
        if (!accept) {
          return {
            status: 'ok',
            event: pushEvent({
              actor: selfActor,
              verb: 'skip-confirm',
              subject_id: p.deal_id,
              field: null,
              old_value: null,
              new_value: p.id,
            }),
          };
        }
        if (p.verb === 'patch-deal-field') {
          return applyFieldWrite({
            deal: p.args.deal,
            field: p.args.field,
            value: p.args.value,
            base_event_id: lastFieldEvent.get(`${p.args.deal}|${p.args.field}`) || null,
            actor: selfActor,
            verb: 'patch-deal-field',
          });
        }
        if (p.verb === 'set-next-step') {
          const d = getDealOrThrow(p.args.deal);
          const old = d.next_step;
          if (old && old.trim()) {
            ensureThread(p.args.deal).unshift({
              id: `n-${dealStore.noteSeq++}`,
              kind: 'archived_step',
              actor: selfActor,
              text: old,
              recorded_at: nowIso(),
            });
          }
          d.next_step = p.args.text;
          d.last_touch = nowIso().slice(0, 10);
          const e = pushEvent({
            actor: selfActor,
            verb: 'set-next-step',
            subject_id: p.args.deal,
            field: 'next_step',
            old_value: old,
            new_value: p.args.text,
          });
          pushHistory(p.args.deal, selfActor, `set next step to "${p.args.text}"`, e.recorded_at);
          return { status: 'ok', event: e };
        }
        if (p.verb === 'create-deal') {
          return client.createDeal({
            name: p.args.name,
            idempotency_key: uuidv4(),
          });
        }
        return { status: 'ok', event: null };
      });
    },

    async simulatePartnerCall() {
      const steps = [];
      const closingDemo = getDealOrThrow('d05');
      const diligenceDemo = getDealOrThrow('d20');

      steps.push({
        at: 400,
        run: () => {
          const expires = new Date(Date.now() + 12000).toISOString();
          leases.set(`${partnerActor}|d05|next_step`, {
            actor: partnerActor,
            deal_id: 'd05',
            field: 'next_step',
            expires_at: expires,
          });
        },
      });

      steps.push({
        at: 1500,
        run: () => {
          const expires = new Date(Date.now() + 10000).toISOString();
          leases.set(`${partnerActor}|d05|next_step`, {
            actor: partnerActor,
            deal_id: 'd05',
            field: 'next_step',
            expires_at: expires,
          });
        },
      });

      steps.push({
        at: 3300,
        run: () => {
          const old = closingDemo.next_step;
          if (old && old.trim()) {
            ensureThread('d05').unshift({
              id: `n-${dealStore.noteSeq++}`,
              kind: 'archived_step',
              actor: partnerActor,
              text: old,
              recorded_at: nowIso(),
            });
          }
          closingDemo.next_step = 'Synthetic signature received';
          closingDemo.next_date = '2026-02-01';
          closingDemo.last_touch = nowIso().slice(0, 10);
          pushEvent({
            actor: partnerActor,
            verb: 'set-next-step',
            subject_id: 'd05',
            field: 'next_step',
            old_value: old,
            new_value: closingDemo.next_step,
          });
          pushEvent({
            actor: partnerActor,
            verb: 'patch-deal-field',
            subject_id: 'd05',
            field: 'next_date',
            old_value: '2026-08-09',
            new_value: '2026-02-01',
          });
          pushHistory('d05', partnerActor, 'set synthetic next step');
          leases.delete(`${partnerActor}|d05|next_step`);
        },
      });

      steps.push({
        at: 5000,
        run: () => {
          void diligenceDemo;
          const expires = new Date(Date.now() + 8000).toISOString();
          leases.set(`${partnerActor}|d20|next_step`, {
            actor: partnerActor,
            deal_id: 'd20',
            field: 'next_step',
            expires_at: expires,
          });
        },
      });

      // call ended: distill proposals (nothing writes without a tap)
      steps.push({
        at: 7200,
        run: () => {
          pendingConfirms = [
            {
              id: `p-${confirmSeq++}`,
              label: 'Demo Family Clinic → phase Closed?',
              deal_id: 'd05',
              verb: 'patch-deal-field',
              args: { deal: 'd05', field: 'phase', value: 'Closed' },
            },
            {
              id: `p-${confirmSeq++}`,
              label: 'Demo Specialty Clinic → next step "accept the sample term"?',
              deal_id: 'd23',
              verb: 'set-next-step',
              args: { deal: 'd23', text: 'accept the sample term' },
            },
            {
              id: `p-${confirmSeq++}`,
              label: 'New deal "Demo Wellness Practice" - create?',
              deal_id: '',
              verb: 'create-deal',
              args: { name: 'Demo Wellness Practice' },
            },
          ];
        },
      });

      steps.push({
        at: 12500,
        run: () => {
          for (const k of [...leases.keys()]) {
            if (k.startsWith(`${partnerActor}|`)) leases.delete(k);
          }
        },
      });

      return { steps };
    },

  };

  let emailFixture;
  const emails = () => emailFixture ||= import('./email-proposals-fixture.js').then(({ createEmailProposalsFixture }) => createEmailProposalsFixture({ deals, seedDeals: emailSeedDeals, actor: selfActor, client, pushEvent, replyDrafts: opts.emailReplyDrafts === true, filingProposals: opts.emailFilingProposals === true, nonDealProposals: opts.emailNonDealProposals === true }));
  Object.assign(client, Object.fromEntries([
    'listEmailProposals', 'previewEmailNextStep', 'previewEmailDealProgress',
    'confirmEmailFiling', 'confirmEmailNextStep', 'confirmEmailDealProgress', 'dismissEmailProposal', 'submitEmailDraft',
  ].map(method => [method, async args => (await emails())[method](args)])));
  return opts.docContext === false ? client : observeDocClient(client);
}

function readMarketTerms(args = {}) {
  const rows = [{canonical_fact_id:'fixture-rent', entity_ref:'d14', fact_key:'rent', version:1, value:'35', unit:'USD/sf/year', expense_basis:'NNN', confidence:'human_review', submarket:'North', use_type:'Office', term_kind:'executed', term_date:'2026-01-01', effective_from:'2026-01-01', effective_to:null, context_source:{document_ref:'fixture-lease'}, sources:[{document_ref:'fixture-lease',page_start:1,page_end:2,quarantined:true}]}].filter(row => (!args.submarket || row.submarket === args.submarket) && (!args.use_type || row.use_type === args.use_type));
  return {ok:true,schema_version:'market-terms.v1',empty:!rows.length,rows,coverage:{recorded_documents:40,canonical_receipts:20,classified_receipts:12,eligible_receipts:1,unsupported_receipts:7,superseded_without_context:4,unclassified_receipts:8,comparable_deals:rows.length}};
}
