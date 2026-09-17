/**
 * Fixture client: full WO-1 contract against in-memory state seeded from
 * data/board-seed.json. Zero network. Live and fixture share one interface.
 */
import { uuidv4 } from './uuid.js';
import { PHASES } from './client.js';
import {
  MY_FLAGGED_DESTINATION, NEEDS_JOE_DESTINATION, TEAM_ACTIVE_DESTINATION, TEAM_FLAGGED_DESTINATION,
} from './workspace-command-center-model.js';

const LEASE_TTL_MS = 3000;
const IDEM_TTL_MS = 60 * 60 * 1000;
/** The cells patch-deal-field bases on; mirrors the record layer's DEAL_ROOM_FIELDS. */
const BASED_FIELDS = ['phase', 'owner', 'attention', 'next_date', 'operating_state'];

/**
 * @param {Object} [opts]
 * @param {string} [opts.seedUrl]
 * @param {string} [opts.selfActor]
 */
export async function createFixtureClient(opts = {}) {
  const seedUrl = opts.seedUrl || new URL('../data/board-seed.json', import.meta.url).href;
  const seed = await fetch(seedUrl).then((r) => {
    if (!r.ok) throw new Error(`fixture seed failed: ${r.status}`);
    return r.json();
  });

  const selfActor = opts.selfActor || seed.actors?.self || 'joe';
  const partnerActor = seed.actors?.partner || 'dell';

  /** @type {Map<string, any>} */
  const deals = new Map(seed.deals.map((d) => [d.id, {
    operating_state: 'active', parking_reason: null, parking_note: null,
    parked_at: null, parked_by: null, ...d,
  }]));
  // Demonstrate that Salesforce-shaped records are not automatically active
  // transactions. These are fixture-only examples; production is never
  // changed from a name match.
  for (const id of ['d06', 'd07', 'd08']) {
    const deal = deals.get(id);
    if (deal) Object.assign(deal, { operating_state:'parked', parking_reason:'other',
      parking_note:'Reason not yet classified', parked_at:'2026-08-10T12:00:00Z', parked_by:'joe' });
  }
  // Keep the local demo representative of the production information model:
  // one national-account portfolio, many market deals, no duplicate deal rows.
  const fixtureAccountId = 'demo-account-001';
  let fixtureAccountOwner = 'dell';
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
  /** @type {Map<string, any[]>} */
  const threads = new Map(
    Object.entries(seed.threads || {}).map(([k, v]) => [k, v.map((x) => ({ ...x }))]),
  );
  /** @type {Map<string, any[]>} */
  const history = new Map(
    Object.entries(seed.history || {}).map(([k, v]) => [k, v.map((x) => ({ ...x }))]),
  );

  /** @type {any[]} events newest-last (append order); cursor is last id */
  const events = [...(seed.seed_events || [])].map((e) => ({ ...e }));
  events.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));

  /** @type {Map<string, {actor:string, deal_id:string, field:string, expires_at:string}>} */
  const leases = new Map(); // key: actor|deal|field

  /** @type {Map<string, any>} idempotency_key -> result */
  const idem = new Map();

  /** @type {Map<string, any>} open conflicts */
  const conflicts = new Map();
  // Critical dates recorded in this session, by deal. The seed carries none:
  // the fixture derives one line from the deal's own next date, and anything
  // else on the list was written here through add-critical-date.
  const criticalDates = new Map();

  /**
   * Synthetic loop records — the task surface's fixture.
   *
   * These exercise the shapes the page has to survive: both partners as owners,
   * a record owned by the system, a jointly owned one, a dated marker, a bell,
   * a counterparty the partnership is waiting on, a team record, and two
   * records that share a number (which is exactly why the number is not an
   * identity and a read by number alone can be ambiguous).
   */
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

  /** The record layer's own version guard, refused the way the server refuses it. */
  function guardVersion(row, baseVersion) {
    if (baseVersion === undefined || baseVersion === null) {
      const error = new Error('fixture update-loop refused: missing_base_version');
      error.payload = { error: 'missing_base_version', hint: 'Re-read the record and send the version it holds now.' };
      throw error;
    }
    if (Number(baseVersion) !== Number(row.version)) {
      const error = new Error('fixture update-loop refused: version_conflict');
      error.payload = { error: 'version_conflict', hint: 'The record changed since you read it. Re-open it and decide from what it holds now.' };
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

  /** field event index: deal|field -> last event id */
  const lastFieldEvent = new Map();
  for (const e of events) {
    if (e.field) lastFieldEvent.set(`${e.subject_id}|${e.field}`, e.id);
  }

  let lastCallAt = seed.last_call_at || '2026-08-07T16:00:00Z';
  let asOf = seed.as_of || '2026-08-08';
  let seq = events.length + 1;
  let conflictSeq = 1;
  let noteSeq = 1;
  let criticalDateSeq = 1;
  let histSeq = 1;
  let confirmSeq = 1;
  let reviewSeq = 1;
  const reviewSessions = new Map();

  function nowIso() {
    return new Date().toISOString();
  }

  function nextEventId() {
    return `e-${String(seq++).padStart(4, '0')}`;
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

  function pushHistory(dealId, actor, summary, at) {
    const h = {
      id: `h-${histSeq++}`,
      actor,
      summary,
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
    };
    events.push(e);
    if (e.field) lastFieldEvent.set(`${e.subject_id}|${e.field}`, e.id);
    return e;
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
      // Only the cells patch-deal-field takes a base for — the record layer's own
      // DEAL_ROOM_FIELDS. A base for anything else would be meaningless, because
      // no other field is written through that verb.
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

  /**
   * Apply a field write. If base_event_id mismatches last known, open conflict.
   */
  function applyFieldWrite({ deal, field, value, base_event_id, actor, verb }) {
    const d = getDealOrThrow(deal);
    const key = `${deal}|${field}`;
    const last = lastFieldEvent.get(key) || null;
    const base = base_event_id === undefined ? null : base_event_id;
    // Optimistic concurrency: client's base must match last event for (deal, field).
    // null means "no event seen"; mismatches (including null vs an id) are conflicts.
    if (last !== base) {
      // conflict: a = server (current), b = incoming
      const conflict_id = `c-${conflictSeq++}`;
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
    });
    pushHistory(deal, actor, `${field} ${old ?? '(empty)'} to ${value ?? '(empty)'}`, e.recorded_at);
    // The committed event's own identity, named the same way the live answer
    // names it, so the board advances a cell's base identically in both modes
    // instead of waiting for the fixture's own changes feed to catch up.
    return { status: 'ok', event: e, event_id: e.id, event_recorded_at: e.recorded_at };
  }

  // ------------------------------------------------- delivery evidence (C11)
  // Five synthetic Work Requests, chosen so that every NON-operational state the
  // Delivery stages table has to be able to show is reachable without a server:
  // built-unmerged, merged-unactivated, active-unproven, a captured record that
  // can actually be withdrawn, and a record whose plan is stale. Nothing here is
  // production state and every ref is visibly a demo one.
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
      passport: passport({ work_request: 'WR-000905', closure_state: 'complete', stale: true, slices: [slice('SL-905-1', 'verified_complete')],
        closure: { work: facet('complete', 'demo-merge-905', 'all planned slices have a bound receipt and independent pass'), proof: facet('complete', 'demo-proof-905', 'all receipts are independently reviewed'), explanation: facet('complete', 'demo-explain-905', 'derived from canonical persisted facts'), release: facet('complete', 'demo-release-905', 'all required slices are verified'), learning: { state: 'unresolved', route: null, evidence_refs: [], note: 'learning remains a proposal/disposition seam' } } }) }],
  ]);
  const portfolios = new Map([
    ['PF-DEMO-1', { portfolio_ref: 'PF-DEMO-1', exists: true, accepted: true, accepted_revision_id: 'PF-DEMO-1-R2', reviews: [{ verdict: 'pass', reviewed_digest: 'e'.repeat(64), reviewer_actor_id: partnerActor }] }],
    ['PF-DEMO-2', { portfolio_ref: 'PF-DEMO-2', exists: true, accepted: false, accepted_revision_id: null, reviews: [] }],
  ]);
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
      refuse(verb, 'version_conflict', { human_ref: row.ref, resolution: 're-read the Work Request card; only its current captured version may be withdrawn' });
    }
  }

  const client = {
    mode: /** @type {const} */ ('fixture'),
    selfActor,

    async getBoard() {
      const national = [...deals.values()].filter((d) => d.account_client_id === fixtureAccountId);
      const activeNational = national.filter((d) => d.operating_state === 'active');
      return {
        actor: selfActor,
        // field_base, the same shape the live read returns: the latest committed
        // event for each editable cell, from the same pass as the values, so a
        // first edit has a base here too. A cell with no history has no entry.
        deals: [...deals.values()].map((d) => ({ ...d, field_base: fieldBaseFor(d.id) })),
        accounts: [{ account_client_id: fixtureAccountId, account_client_ref: 'DEMO-ACCOUNT-001',
          account_name: 'Demo National Practice', account_owner: fixtureAccountOwner, open_deals: activeNational.length,
          attention_deals: activeNational.filter((d) => d.attention).length,
          overdue_deals: 0, stale_deals: 2,
          parked_deals: national.length - activeNational.length, last_review_at: lastCallAt }],
        open_session: [...reviewSessions.values()].find((s) => s.status === 'open') || null,
        as_of: asOf,
        last_call_at: lastCallAt,
      };
    },

    async getDeal(dealId) {
      const deal = { ...getDealOrThrow(dealId) };
      const thread = (threads.get(dealId) || [])
        .slice()
        .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
      const hist = (history.get(dealId) || [])
        .slice()
        .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
      const critical_dates = [];
      if (deal.next_date) {
        critical_dates.push({
          label: deal.id === 'd14' ? 'Lease commencement' : 'Next date',
          date: deal.next_date,
        });
      }
      for (const entry of criticalDates.get(dealId) || []) critical_dates.push({ ...entry });
      return { deal, thread, critical_dates, history: hist,
        next_actions: deal.next_step ? [{ id: `a-${deal.id}`, owner: deal.owner,
          description: deal.next_step, due_on: deal.next_date, status: 'open' }] : [],
        activities: hist.slice(0, 4).map((h) => ({ id: h.id, actor: h.actor,
          occurred_at: h.recorded_at, kind: 'note', summary: h.summary })),
        participants: [{ role: 'lead', name: actorLabel(deal.owner), actor: deal.owner }],
        premises: [], negotiation_rounds: [], documents: [] };
    },

    async getChanges(cursor) {
      pruneLeases();
      const fresh = eventsAfter(cursor);
      return {
        events: fresh.map((e) => ({ ...e })),
        presence: [...leases.values()].map((p) => ({ ...p })),
        capture_sessions: [],
        cursor: cursorOf(events),
      };
    },

    async presenceLease({ deal, field, idempotency_key }) {
      // lease is not a write to deal data; idempotency still accepted
      void idempotency_key;
      getDealOrThrow(deal);
      const expires = new Date(Date.now() + LEASE_TTL_MS).toISOString();
      const key = `${selfActor}|${deal}|${field}`;
      leases.set(key, { actor: selfActor, deal_id: deal, field, expires_at: expires });
      return { ok: true };
    },

    async patchDealField({ deal, field, value, base_event_id, idempotency_key }) {
      return withIdem(idempotency_key, () =>
        applyFieldWrite({
          deal,
          field,
          value,
          base_event_id: base_event_id ?? null,
          actor: selfActor,
          verb: 'patch-deal-field',
        }),
      );
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

    async addDealNote({ deal, text, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        getDealOrThrow(deal);
        const t = String(text || '').trim();
        if (!t) throw new Error('empty note');
        const entry = {
          id: `n-${noteSeq++}`,
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

    // A date that matters, with where it came from. The record layer refuses a
    // critical date without a source, and so does this: a fixture that accepted
    // one would let a surface ship a dialog the live verb would bounce.
    async addCriticalDate({ deal, kind, due_on, source, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        getDealOrThrow(deal);
        const k = String(kind || '').trim();
        const day = String(due_on || '').trim();
        const from = String(source || '').trim();
        if (!k) throw new Error('critical date kind required');
        if (!day) throw new Error('critical date due_on required');
        if (!from) throw new Error('critical date source required');
        const entry = { id: `cd-${criticalDateSeq++}`, kind: k, label: k, due_on: day, date: day, source: from };
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

    async setNextStep({ deal, text, next_date, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const d = getDealOrThrow(deal);
        const t = String(text || '').trim();
        if (!t) throw new Error('empty next step');
        const old = d.next_step;
        // archive old step into the thread with attribution
        if (old && old.trim()) {
          ensureThread(deal).unshift({
            id: `n-${noteSeq++}`,
            kind: 'archived_step',
            actor: selfActor,
            text: old,
            recorded_at: nowIso(),
          });
        }
        d.next_step = t;
        if (next_date !== undefined) d.next_date = next_date || null;
        d.last_touch = nowIso().slice(0, 10);
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

    async createDeal({ name, client, deal_type, phase, segment, market, lane, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const n = String(name || '').trim();
        if (!n) throw new Error('empty name');
        const id = `d-new-${seq++}`;
        const d = {
          id,
          name: n,
          type: deal_type || 'Other',
          phase: phase || 'On Deck',
          owner: selfActor,
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

    // ---------------------------------------------------------------- loops
    // The same six verbs the live client serves, against the synthetic loops
    // above. The answer shapes are the record layer's own, including the one
    // that matters most on this surface: `read-loop` returns a miss IN the
    // payload rather than throwing, and only a real refusal throws with a
    // payload the command kernel can classify.
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

    // The record layer's own answer shape: {count, blocks:[...]} with the
    // version edit-loop-header would need as base_version.
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

    // ------------------------------------------------- delivery evidence (C11)
    // The three reads REFUSE a miss rather than answering an empty one, because
    // an empty answer would paint as "no evidence" where the truth is "unknown".
    // The three writes are captured-only or pre-build-only exactly as the record
    // layer is, they demand the version the card last held, and they replay a
    // stored answer under a spent key instead of writing a second time.
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

    // ---------------------------------------------------------- command centre
    // The synthetic twin of the aggregate Home read. It is BUILT FROM THE SAME
    // fixture board the rest of this client serves, so the counts a person sees
    // on Home are the counts they see on the board — a hand-written constant
    // here would let the two surfaces disagree and teach a reader to distrust
    // whichever one they checked second.
    //
    // Every stamp is minted against the current clock with the contract's own
    // 60-second window, because a fixture with a frozen `valid_until` would show
    // the expired path on every run and never exercise the fresh one.
    async commandCenter() {
      const now = Date.now();
      const observed_at = new Date(now).toISOString();
      const valid_until = new Date(now + 60_000).toISOString();
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

    async setMarketAgent({ deal, agent_name, market, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const d = getDealOrThrow(deal); d.market_agent = agent_name; if (market) d.market = market;
        return { ok: true, deal_id: deal, market_agent: agent_name };
      });
    },

    async setNationalAccountOwner({ account_client_id, owner, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        fixtureAccountOwner = owner;
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
      return client.createDeal({ name: args.deal_name, client: args.client_name,
        deal_type: args.deal_type || 'Startup', phase: args.phase || 'On Deck',
        segment: args.segment, market: args.market, lane: 'national',
        idempotency_key: args.idempotency_key });
    },

    async revertDealField({ event_id, idempotency_key }) {
      return withIdem(idempotency_key, () => {
        const event = events.find((e) => e.id === event_id);
        if (!event) throw new Error('event not found');
        const d = getDealOrThrow(event.subject_id);
        if (event.field === 'operating_state') {
          const prior = event.old_value;
          d.operating_state = prior.state;
          d.parking_reason = prior.reason || null;
          d.parking_note = prior.note || null;
          d.parked_at = prior.state === 'parked' ? nowIso() : null;
          d.parked_by = prior.state === 'parked' ? selfActor : null;
        } else d[event.field] = event.old_value;
        return { ok: true, deal_id: d.id, field: event.field, new_value: event.old_value };
      });
    },

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
        // apply proposal via same write path (nothing auto-writes)
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
              id: `n-${noteSeq++}`,
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

    /**
     * Fixture-only: partner presence + partner write + call distill proposals.
     * Wired through the same event log and presence map the UI polls.
     */
    async simulatePartnerCall() {
      const steps = [];
      const closingDemo = getDealOrThrow('d05');
      const diligenceDemo = getDealOrThrow('d20');

      // partner joins
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

      // Partner holds the synthetic closing deal's next_step.
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

      // Partner writes the synthetic closing deal (live write, not confirm).
      steps.push({
        at: 3300,
        run: () => {
          const old = closingDemo.next_step;
          if (old && old.trim()) {
            ensureThread('d05').unshift({
              id: `n-${noteSeq++}`,
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

      // Partner presence on the synthetic diligence deal.
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

    /** Test helper: force a conflict by writing without advancing base. */
    async _forceConflict(deal, field, valueA, valueB) {
      const key = `${deal}|${field}`;
      const base = lastFieldEvent.get(key) || null;
      applyFieldWrite({
        deal,
        field,
        value: valueA,
        base_event_id: base,
        actor: partnerActor,
        verb: 'patch-deal-field',
      });
      // second write with stale base
      return applyFieldWrite({
        deal,
        field,
        value: valueB,
        base_event_id: base,
        actor: selfActor,
        verb: 'patch-deal-field',
      });
    },

    _lastFieldEventId(deal, field) {
      return lastFieldEvent.get(`${deal}|${field}`) || null;
    },

    _setLastCallAt(iso) {
      lastCallAt = iso;
    },
  };

  return client;
}
