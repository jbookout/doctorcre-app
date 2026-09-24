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
  // `version` is the record layer's own optimistic-concurrency counter for the
  // deal ROW (what `update-deal` demands as `base_version`), which is a
  // different thing from `field_base`, the per-cell event identity that
  // `patch-deal-field` guards with. Both exist because CARR has both.
  const deals = new Map(seed.deals.map((d) => [d.id, {
    operating_state: 'active', parking_reason: null, parking_note: null,
    parked_at: null, parked_by: null, version: 1,
    outcome: null, closed_on: null, won_value: null, ...d,
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
  // d02 names a client id the business-record fixture below deliberately does
  // not carry, so the V5-UX-B04 context drawer's fetch-failure state (test
  // fixture client, not a live network fault) has a fixture deal to exercise.
  const brokenClientDeal = deals.get('d02');
  if (brokenClientDeal) brokenClientDeal.account_client_id = 'demo-account-002-unlisted';
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

  // V5-UX-B04: attached parties/vendors beyond the standing 'lead' row —
  // client_contact, referring_agent and listing_side are the deal_participant
  // roles that carry an external party_id rather than an internal actor. Only
  // d01 carries any, which is exactly what makes it the "populated" fixture
  // deal and every other deal the "no parties" one.
  const extraParticipants = new Map([
    ['d01', [
      { role: 'client_contact', name: 'Dr. Dana Ortiz', party_id: 'demo-party-101' },
      { role: 'referring_agent', name: 'Sam Rivera', party_id: 'demo-party-102' },
      { role: 'listing_side', name: 'Casey Nguyen · Demo Realty', party_id: 'demo-party-103' },
    ]],
  ]);

  // V5-UX-B04: the fixture stand-in for the pinned `/api/v1/business/{clients,
  // vendors}/<id>` single-record read, keyed by that record's own id — never
  // by a party_id, matching the live shape (client.id/vendor.id, joined
  // through party_id, are never the same value as a deal participant's
  // party_id). d02's account_client_id is deliberately absent from this map;
  // see the note where it is set.
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
      // The partner's own words, carried on the event and nowhere else: they
      // describe the change, not the deal, so the deal row never learns them.
      change_reason: partial.change_reason ?? null,
      human_quote: partial.human_quote ?? null,
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
  function applyFieldWrite({ deal, field, value, base_event_id, actor, verb, change_reason, human_quote }) {
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
      change_reason: change_reason ?? null,
      human_quote: human_quote ?? null,
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
      refuse(verb, 'version_conflict', { human_ref: row.ref, resolution: 're-read the Work Request card; only its current captured version may be withdrawn' });
    }
  }

  /* ------------------------------------------------- Control Room fixtures (C01)
   * Three severities, one row ready to close, one recurring row; three held
   * work items with distinct silences and one blocker; two shared requests.
   * Every name starts with "Demo " so nothing here can be mistaken for a record.
   */

  /* ------------------------------------------- Sessions tab fixtures (V5-UX-S02)
   *
   * The identity corpus is the REAL production answer, captured read-only as Joe
   * on 2026-09-18 against producer 0f6cb388 and held verbatim in
   * test/fixtures/session-identity.json. Three numbers in it are the point:
   * total_seen 603, total_returned 124, and 25 rows. `total_returned` is the
   * post-permission-filter total BEFORE `limit`, so a fixture whose
   * total_returned equalled sessions.length would hide the one invariant this
   * tab exists to render honestly, and is forbidden.
   *
   * Every live row carries the same seven constants — harvested surface, derived
   * alias, unknown state, harvest observation, unsupported host, unknown parent,
   * one attempt — so they are spelled once in `harvested()` and the 25 rows below
   * differ only where the production rows differ. Test S02-20 compares the whole
   * corpus against the captured file, so "verbatim" is checked rather than
   * asserted.
   *
   * FOUR synthetic rows follow, and no more. Each one exists for a branch the
   * live corpus cannot reach, each is named with the branch it serves, and each
   * is marked `synthetic: true` in the capture file. That marker is NOT part of
   * the payload the page sees: the page must not be able to render it.
   */
  const harvested = (id, name, affinity, evidence, observedAt) => ({
    canonical_session_id: id,
    surface: 'harvested',
    display_name: name,
    alias_source: 'derived',
    parent_session_id: null,
    parent_known: false,
    native_host_id: null,
    native_host_supported: false,
    work_state: 'unknown',
    work_state_evidence: evidence,
    last_observed_at: observedAt,
    observation_source: 'harvest',
    project_affinity: affinity,
    latest_cwd: null,
    latest_model_id: null,
    attempt_count: 1,
    latest_attempt_ref: null,
  });

  const SESSION_LIVE_ROWS = [
    harvested("promise:phone-doc-no-claude", "Phone Doc does not spawn Claude", "promise", "harvest row observed at 2026-08-22T01:33:11Z, age 28 days 01:40:28.271514; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:11.526676+00:00"),
    harvested("promise:loop-455-waits-fable", "Loop 455 waits for Fable", "promise", "harvest row observed at 2026-08-22T01:33:11Z, age 28 days 01:40:28.271514; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:11.526676+00:00"),
    harvested("promise:codex-trees-stay", "Codex control-plane trees stay", "promise", "harvest row observed at 2026-08-22T01:33:11Z, age 28 days 01:40:28.271514; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:11.526676+00:00"),
    harvested("promise:bot-mode-parked", "Bot Mode parked", "promise", "harvest row observed at 2026-08-22T01:33:11Z, age 28 days 01:40:28.271514; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:11.526676+00:00"),
    harvested("kanban:t_deed8d22", "Partner line: cross-Mac relay Joe Claude to Dell Claude", "kanban", "harvest row observed at 2026-08-22T01:33:10Z, age 28 days 01:40:29.240986; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:10.557204+00:00"),
    harvested("kanban:t_93cfd1ee", "STANDING: land or kill \u2014 3 live, local CI, one paid run", "kanban", "harvest row observed at 2026-08-22T01:33:10Z, age 28 days 01:40:29.240986; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:10.557204+00:00"),
    harvested("kanban:t_1d8844ea", "Build the Doc\u2194Claude live bridge (named inject, not claude -p)", "kanban", "harvest row observed at 2026-08-22T01:33:10Z, age 28 days 01:40:29.240986; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:10.557204+00:00"),
    harvested("kanban:t_0834239a", "Post-turn review writes to Neon, not MEMORY.md", "kanban", "harvest row observed at 2026-08-22T01:33:10Z, age 28 days 01:40:29.240986; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:10.557204+00:00"),
    harvested("hermes_session:20260821_164448_e1a4cc", "Create Designer agent prof   carr-system        just", "hermes_session", "harvest row observed at 2026-08-22T01:33:08Z, age 28 days 01:40:31.021729; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:08.776461+00:00"),
    harvested("hermes_session:20260821_160917_5b69c4", "Industry strategies for AI   carr-system        just", "hermes_session", "harvest row observed at 2026-08-22T01:33:08Z, age 28 days 01:40:31.021729; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:08.776461+00:00"),
    harvested("hermes_session:20260820_112318_0b157a", "work kanban task t_4d48865   \u2014", "hermes_session", "harvest row observed at 2026-08-22T01:33:08Z, age 28 days 01:40:31.021729; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:08.776461+00:00"),
    harvested("hermes_session:20260820_112218_4c7b27", "\u2014                            \u2014", "hermes_session", "harvest row observed at 2026-08-22T01:33:08Z, age 28 days 01:40:31.021729; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:08.776461+00:00"),
    harvested("hermes_session:20260820_112117_f34276", "\u2014                            \u2014", "hermes_session", "harvest row observed at 2026-08-22T01:33:08Z, age 28 days 01:40:31.021729; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:08.776461+00:00"),
    harvested("hermes_session:20260820_112017_8e5ae8", "work kanban task t_4d48865   \u2014", "hermes_session", "harvest row observed at 2026-08-22T01:33:08Z, age 28 days 01:40:31.021729; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:08.776461+00:00"),
    harvested("hermes_session:20260819_141911_fd5c46", "Create Dell systems connec   carr-system        2d", "hermes_session", "harvest row observed at 2026-08-22T01:33:08Z, age 28 days 01:40:31.021729; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:08.776461+00:00"),
    harvested("hermes_session:20260819_070417_0cb77a", "Merge Pelham Tire property   carr-system        2d", "hermes_session", "harvest row observed at 2026-08-22T01:33:08Z, age 28 days 01:40:31.021729; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:08.776461+00:00"),
    harvested("hermes_session:20260819_001819_7ab8f5", "Work kanban task t_3c1b692   \u2014                  2d", "hermes_session", "harvest row observed at 2026-08-22T01:33:08Z, age 28 days 01:40:31.021729; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:08.776461+00:00"),
    harvested("hermes_session:20260818_215618_9476d2", "Work kanban task t_bfeef20   \u2014                  2d", "hermes_session", "harvest row observed at 2026-08-22T01:33:08Z, age 28 days 01:40:31.021729; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:08.776461+00:00"),
    harvested("hermes_session:20260818_200318_ec907827", "Friendly greeting            \u2014                  3d", "hermes_session", "harvest row observed at 2026-08-22T01:33:08Z, age 28 days 01:40:31.021729; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:08.776461+00:00"),
    harvested("hermes_session:20260816_102322_1bf766", "Reply with exactly: defaul   carr-system        just", "hermes_session", "harvest row observed at 2026-08-22T01:33:08Z, age 28 days 01:40:31.021729; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:08.776461+00:00"),
    harvested("worktree:/private/tmp/claude-501/-Users-booko-carr-system/b491f57b-8a8b-4456-967f-5173fe0f5934/scratchpad/carr-mainchk", "carr-mainchk", "worktree", "harvest row observed at 2026-08-22T01:33:07Z, age 28 days 01:40:31.910454; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:07.887736+00:00"),
    harvested("worktree:/private/tmp/carr-typed-guidance-final-ci.aARZr2/worktree", "worktree", "worktree", "harvest row observed at 2026-08-22T01:33:07Z, age 28 days 01:40:31.910454; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:07.887736+00:00"),
    harvested("worktree:/private/tmp/carr-system-release-418", "carr-system-release-418", "worktree", "harvest row observed at 2026-08-22T01:33:07Z, age 28 days 01:40:31.910454; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:07.887736+00:00"),
    harvested("worktree:/private/tmp/carr-system-program6-final2", "carr-system-program6-final2", "worktree", "harvest row observed at 2026-08-22T01:33:07Z, age 28 days 01:40:31.910454; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:07.887736+00:00"),
    harvested("worktree:/private/tmp/carr-system-program6-final", "carr-system-program6-final", "worktree", "harvest row observed at 2026-08-22T01:33:07Z, age 28 days 01:40:31.910454; the harvest stamps its own run time and is not scheduled, so liveness is not claimed", "2026-08-22T01:33:07.887736+00:00"),
  ];

  const SESSION_SYNTHETIC_ROWS = [
    // retry — attempt_count > 1 with a latest_attempt_ref; rule 1 of the lineage procedure. No live row reaches it.
    {
          "canonical_session_id": "11111111-1111-4111-8111-111111111111",
          "surface": "claude",
          "display_name": "Synthetic retry seat",
          "alias_source": "derived",
          "parent_session_id": null,
          "parent_known": false,
          "native_host_id": null,
          "native_host_supported": false,
          "work_state": "working",
          "work_state_evidence": "continuity event observed at 2026-09-18T12:00:00Z; the seat recorded the turn itself, so the state is the seat's own report",
          "last_observed_at": "2026-09-18T12:00:00+00:00",
          "observation_source": "continuity_event",
          "project_affinity": "doctorcre-app",
          "latest_cwd": "/synthetic/doctorcre-app",
          "latest_model_id": "claude-opus-5[1m]",
          "attempt_count": 3,
          "latest_attempt_ref": "WR-000117#3"
    },
    // replacement — a non-null parent_session_id; rule 2. No live row reaches it.
    {
          "canonical_session_id": "22222222-2222-4222-8222-222222222222",
          "surface": "codex",
          "display_name": "Synthetic replacement seat",
          "alias_source": "derived",
          "parent_session_id": "11111111-1111-4111-8111-111111111111",
          "parent_known": true,
          "native_host_id": null,
          "native_host_supported": false,
          "work_state": "idle",
          "work_state_evidence": "continuity event observed at 2026-09-18T12:00:00Z; the seat recorded the turn itself, so the state is the seat's own report",
          "last_observed_at": "2026-09-18T11:30:00+00:00",
          "observation_source": "checkpoint",
          "project_affinity": "doctorcre-app",
          "latest_cwd": null,
          "latest_model_id": null,
          "attempt_count": 1,
          "latest_attempt_ref": null
    },
    // resume — parent_known true with a null parent and attempt_count 1; rule 3. No live row reaches it.
    {
          "canonical_session_id": "33333333-3333-4333-8333-333333333333",
          "surface": "capability",
          "display_name": "Synthetic resumed root",
          "alias_source": "derived",
          "parent_session_id": null,
          "parent_known": true,
          "native_host_id": null,
          "native_host_supported": false,
          "work_state": "complete_unacknowledged",
          "work_state_evidence": "continuity event observed at 2026-09-18T12:00:00Z; the seat recorded the turn itself, so the state is the seat's own report",
          "last_observed_at": "2026-09-18T10:00:00+00:00",
          "observation_source": "server_session",
          "project_affinity": null,
          "latest_cwd": null,
          "latest_model_id": null,
          "attempt_count": 1,
          "latest_attempt_ref": null
    },
    // host title mismatch — native_host_supported true with a native_host_id the display_name differs from; the third branch of clause 2. No live row reaches it.
    {
          "canonical_session_id": "44444444-4444-4444-8444-444444444444",
          "surface": "claude",
          "display_name": "Synthetic mismatched title",
          "alias_source": "derived",
          "parent_session_id": null,
          "parent_known": false,
          "native_host_id": "host-window-7",
          "native_host_supported": true,
          "work_state": "disconnected",
          "work_state_evidence": "continuity event observed at 2026-09-18T12:00:00Z; the seat recorded the turn itself, so the state is the seat's own report",
          "last_observed_at": "2026-09-18T09:00:00+00:00",
          "observation_source": "continuity_event",
          "project_affinity": null,
          "latest_cwd": null,
          "latest_model_id": "claude-opus-5[1m]",
          "attempt_count": 1,
          "latest_attempt_ref": null
    },
  ];

  const SESSION_ROWS = [...SESSION_LIVE_ROWS, ...SESSION_SYNTHETIC_ROWS];

  /** The one synthetic session that carries dispatch events to render. */
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

  /* ------------------------------------------- Model Room fixtures (C12)
   * The four captured queue events and five captured room turns, in the
   * producer's shape. One card carries `source_seq: null` and one body is a
   * JSON STATUS envelope, because both are true of the live answer and both
   * are branches the tab must render without inventing anything.
   */
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
    // The OBJECT branch of `effective_model`. The producer accepts a string or
    // an object; no live row carries an object today, so only a fixture can
    // prove the branch renders instead of printing [object Object].
    { v: 1, board: 'carr-build', event_id: 1297, event: 'review_requested', task_id: 't_a80efc8b',
      card: { title: 'Fresh independent Opus 5 High review', target: 'claude-desktop',
        effective_model: { id: 'claude-opus-5-high', host: 'desktop' }, status: 'review',
        priority: 'P2', cap: 'read', updated_at: '2026-08-31T22:41:10Z', source_seq: 8529 },
      summary: 'Fresh independent Opus 5 High review is awaiting review.',
      projected_at: '2026-08-31T22:41:10Z' },
    // `source_seq: null`, which the producer explicitly permits.
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
      // A JSON envelope, carried as TEXT. The page never parses it.
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
    business_impact: row.business_impact, fingerprint: `demo-service|${row.severity}|demo`,
    detected_at: row.detected_at, observed_at: row.detected_at, monitoring_until: null,
    duplicate_of: null, monitoring_window_open: false, age_days: row.age_days,
    occurrences: row.occurrences, occurrence_evidence_status: 'complete',
    legacy_overlap_unknown: false, unresolved_occurrence_edge_count: 0,
    ready_to_close: row.ready_to_close, blocked_by: row.blocked_by || null,
  });
  const incidents = [
    incident({ ref: 'INC-20260915-01', title: 'Demo export service stopped writing its nightly generation', severity: 'SEV-1', state: 'investigating', owner_actor: 'joe', next_action: 'Read the demo export log and name the failing generation', business_impact: 'The demo nightly export is not being produced', detected_at: '2026-09-13T04:10:00.000Z', age_days: 4, occurrences: 6, ready_to_close: false, blocked_by: 'no recovery evidence — supply one, or adjudicate it as a duplicate' }),
    incident({ ref: 'INC-20260916-02', title: 'Demo search read is answering slowly under the demo load', severity: 'SEV-2', state: 'mitigating', owner_actor: 'dell', next_action: 'Hold the demo cache warm until the read settles', business_impact: 'Demo search answers late', detected_at: '2026-09-15T11:25:00.000Z', age_days: 2, occurrences: 28, ready_to_close: false, blocked_by: 'no recovery evidence — supply one, or adjudicate it as a duplicate' }),
    incident({ ref: 'INC-20260916-03', title: 'Demo staging deploy retried once and then succeeded', severity: 'SEV-3', state: 'monitoring', owner_actor: 'joe', next_action: 'Close it once the demo monitoring window has elapsed', business_impact: 'None observed after the retry', detected_at: '2026-09-16T09:40:00.000Z', age_days: 1, occurrences: 1, ready_to_close: true, blocked_by: null }),
  ];
  /* -------------------------------------------- notification fixtures (B12a)
   * The synthetic twin of `ops.notification`, in the producer's OWN shape: a
   * closed two-value severity set with no informational member, a per-channel
   * delivery list, and a relative deep link with no scheme, host or query.
   * `read_at` is the ONLY thing an acknowledgement is allowed to move, which is
   * why the rows carry nothing else an acknowledgement could plausibly touch.
   */
  const notifications = (seed.notifications || []).map((row) => ({
    ...row, delivery: (row.delivery || []).map((entry) => ({ ...entry })),
  }));
  /** The feed function's own clamp: 1..200, applied before anything is read. */
  const clampLimit = (value) => {
    if (!Number.isInteger(value)) return 50;
    return Math.min(200, Math.max(1, value));
  };

  /* ------------------------------ notification preferences (B12, WR-000116)
   * The synthetic twin of `ops.notification_preference`. It starts with NO ROW
   * unless the seed names one, because "no row yet" is a state the page prints
   * and a fixture that started saved would never show it: `exists` is false,
   * `version` is 1, the window is null and the timezone is UTC — migration
   * 0527's documented defaults, not this file's invention.
   *
   * `quiet_now` is computed here the way 0527 computes it, INCLUDING the
   * wrap-around window (23:00-07:00 is a window that crosses midnight, and a
   * fixture that only handled start<=end would certify a page against half the
   * real behaviour). The timezone list is the browser's own IANA list, so an
   * unknown zone is refused here for the same reason the store refuses it.
   */
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
      // The browser's own database answers this; a hand-written list would be
      // a second, staler copy of `pg_timezone_names`.
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

  /* --------------------------------------------- incident detail fixtures (C14)
   * The synthetic twin of `get-incident`, in the verb's OWN shape: the row,
   * then FOUR separate lists. Facts and hypotheses are separate arrays here for
   * the same reason they are separate regions on the page — a hypothesis drawn
   * as a fact is the failure that surface exists to prevent — and every fact
   * carries its own source and its own clock.
   */
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
    }],
  ]);

  /* -------------------------------------- Doc conversation fixtures (V5-UX-B07)
   * The synthetic twin of `ops.doc_conversation`, in the producer's OWN shape.
   * Three things about this fixture are the point of it, and a friendlier one
   * would let the page pass its tests while shipping a disclosure:
   *
   *  1. ABSENT and NOT-YOURS are ONE answer. `doc_conversation_not_found` is
   *     returned for an id that does not exist, for one this actor cannot see,
   *     and for an id that is not a uuid — byte-identical in all three cases.
   *  2. `doc_conversation_creator_only` is NOT collapsed into that. A grantee
   *     already knows the conversation exists, so a distinct refusal discloses
   *     nothing and is the honest answer a share toggle needs.
   *  3. `visible_conversation_count` is computed the way the definer computes
   *     it — over conversations this ACTING actor created or holds an unrevoked
   *     grant on — so `?actor=dell` demonstrably changes the number.
   *
   * Every title starts with "Demo " so nothing here can be mistaken for a record.
   */
  const DOC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  /** The active actor slugs `share-doc-conversation` can resolve. */
  const DOC_ACTORS = [seed.actors?.self || 'joe', partnerActor];
  const docTurn = (sequence, role, body, at) => ({
    sequence, role, body, msg_id: `demo-msg-${String(sequence).padStart(2, '0')}`,
    origin_channel: 'app', origin_actor: role === 'assistant' ? 'doc' : 'joe', at,
  });
  const docConversation = (row) => ({
    id: row.id, title: row.title, pinned_at: row.pinned_at || null,
    archived_at: row.archived_at || null, version: row.version, created_by: row.created_by,
    // A STORED column, not a derivation. `ops.doc_conversation.visibility` is
    // set at create (0523:75-78), overwritten to 'shared' by a grant
    // (0523:181-183) and recomputed from the REMAINING unrevoked grants by a
    // revoke (0523:196-201). The read door returns that column verbatim
    // (0520:218). Deriving it from the grant list agrees with the store for
    // share and revoke and DISAGREES for create, where the store reaches
    // "visibility shared, zero grants" — a real state that a derived field
    // cannot represent, and therefore that no test could ever cover.
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
        // Two hostile bodies, so the page's escaping is exercised by a real turn
        // rather than by a test-only fabrication.
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
      // The revoke recomputed the column back to private; the grant row remains.
      visibility: 'private',
      archived_at: '2026-09-12T17:00:00.000Z',
      turns: [
        docTurn(0, 'human', 'Demo: has the demo surveyor answered yet?', '2026-09-12T15:10:00.000Z'),
        docTurn(1, 'assistant', 'Demo: no demo answer since Monday.', '2026-09-12T15:10:30.000Z'),
        docTurn(2, 'human', 'Demo: put it away, and take the demo partner back off it.', '2026-09-12T16:55:00.000Z'),
      ],
      // Revoked, never deleted: the row stays and carries its `revoked_at`.
      grants: [{ grantee_actor: partnerActor, granted_at: '2026-09-12T15:20:00.000Z', granted_by_actor: 'joe', revoked_at: '2026-09-12T16:58:00.000Z' }],
    })],
    // The state EVERY shared create reaches in production, and the one a fixture
    // that derived visibility from the grant list could not represent at all:
    // the header column says `shared` (0523:75-78 writes it) and the grant table
    // is empty (that function inserts no grant). The read door gates on
    // creator-or-unrevoked-grant (0520:186-189), so the partner is refused —
    // a header that says shared is not a grant.
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
  /**
   * Written by every rename and read back by nothing, exactly as
   * `ops.doc_conversation_title_revision` is written and projected by no verb.
   * It exists here so a test can prove the page does NOT show it.
   */
  const docTitleRevisions = [];
  /** What each spent key was spent ON; a different payload is `key_reuse`. */
  const docIdemArgs = new Map();

  const docLiveGrants = (row) => row.grants.filter((grant) => !grant.revoked_at);
  /** 0523:196-201: a revoke recomputes the column from what is LEFT unrevoked. */
  const docRecomputeVisibility = (row) => {
    row.visibility = docLiveGrants(row).length ? 'shared' : 'private';
    return row.visibility;
  };
  const docVisibleTo = (row, actor) => row.created_by === actor
    || docLiveGrants(row).some((grant) => grant.grantee_actor === actor);
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
    { human_ref: 'WR-000904', title: 'Demo bounded request: decide the demo retention window', state: 'needs_joe', source: { label: 'Demo council minute', freshness: 'fresh' }, next_human_action: 'Name the demo retention window in the record layer' },
    { human_ref: 'WR-000905', title: 'Demo bounded request: accept the demo ready plan', state: 'needs_joe', source: { label: 'Demo ready plan', freshness: 'stale' }, next_human_action: 'Accept or decline the demo ready plan' },
    // V5-UX-C13a: two more shared requests, distinct from WR-000901..905 above
    // (those keep the sparse engineering-passport card shape B10a already
    // tests). WR-000906 exercises the enriched card with every honest field
    // PRESENT; WR-000907 exercises the same shape with the optional ones
    // explicitly ABSENT, which is the honesty case this slice exists to prove.
    { human_ref: 'WR-000906', title: 'Demo bounded request: reconcile the demo vendor names', state: 'needs_joe', source: { label: 'Demo vendor merge review', freshness: 'fresh' }, next_human_action: 'Confirm the demo vendor merge' },
    { human_ref: 'WR-000907', title: 'Demo bounded request: publish the demo rate card', state: 'needs_joe', source: { label: 'Demo rate card review', freshness: 'stale' }, next_human_action: 'Approve or hold the demo rate card' },
    // WR-000908 is named here but carries NO card below and NO passport entry:
    // its work-request-card read genuinely refuses, which is C13a's
    // fetch-failure case for the enriched "Waiting for Joe" detail.
    { human_ref: 'WR-000908', title: 'Demo bounded request: retire the demo legacy export', state: 'needs_joe', source: { label: 'Demo retirement note', freshness: 'fresh' }, next_human_action: 'Confirm the demo legacy export is retired' },
  ];
  /**
   * V5-UX-C13a: the enriched `work-request-card` shape for WR-000906 and
   * WR-000907, in the PRODUCER'S OWN field names (ops.work_request_card,
   * migration 0493): `desired_outcome`, `acting_identity` (ordered by
   * `acted_at`, ascending — never re-sorted here or in the browser),
   * `outcome_feedback_history` (ordered oldest-first) and `incident_evidence`.
   * Neither row carries `recommended_answer` or `business_impact`, because no
   * pinned verb returns either field today — that absence is production's own
   * shape, not an omission of this fixture.
   */
  const sharedRequestCards = new Map([
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
      // No desired_outcome on this row: the card genuinely carries no field
      // for it, and the enrichment must say so rather than fall back to the
      // title or the next_human_action.
      desired_outcome: null,
      state: 'needs_joe', version: 1, projection_state: 'queued',
      acceptance_criteria: [],
      source: { label: 'Demo rate card review', freshness: 'stale' },
      triage: null, plan: null, outcome_feedback: null, pending_outcome_feedback: null,
      outcome_feedback_history: [], accepted_feedback_count: 0,
      // An empty evidence list is a REAL answer (the field exists, and is
      // empty), never confused with the field being absent.
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
    { name: 'Demo Pensacola Orthopedic Partners', city: null, specialty: null, org_name: null, ref: 'C-902', kind: 'client', merged: false },
    { name: 'Demo Pensacola Buildout Contractors', city: 'Pensacola', specialty: null, org_name: null, ref: 'V-903', kind: 'vendor', merged: false },
    // A bare party: no kind of its own beyond "party", and no ref at all. The
    // producer selects `ref` as a plain column and guards it with a string test,
    // which is the producer telling you it can be absent.
    { name: 'Demo Pensacola Referring Physician', city: null, specialty: null, org_name: null, ref: null, kind: 'party', merged: false },
    // A retired alias. It sorts FIRST by `merged, similarity desc`, carries a
    // retired badge and opens nothing.
    { name: 'Demo Pensacola Smiles (retired alias)', city: null, specialty: null, org_name: null, ref: 'L-904', kind: 'lead', merged: true },
  ];

  const searchOrganizations = [
    // The observed shape: a live row whose aggregated ref is a NULL ELEMENT.
    { name: 'Demo Pensacola Imaging Partners', live_rows: 1, refs: [null], retired_aliases: 0, retired_refs: [], retired_refs_truncated: false, live_as_role: 0, role_refs: [], all_retired: false },
    { name: 'Demo Specialty Center Of Pensacola', live_rows: 1, refs: [null], retired_aliases: 0, retired_refs: [], retired_refs_truncated: false, live_as_role: 1, role_refs: ['L-905'], all_retired: false },
    { name: 'Demo Pensacola Surgical Suites', live_rows: 2, refs: ['P-906', 'P-907'], retired_aliases: 0, retired_refs: [], retired_refs_truncated: false, live_as_role: 0, role_refs: [], all_retired: false },
    { name: 'Demo Pensacola Retired Holdings', live_rows: 0, refs: [], retired_aliases: 3, retired_refs: ['P-908', 'P-909', 'P-910'], retired_refs_truncated: false, live_as_role: 0, role_refs: [], all_retired: true },
    // Twelve retired aliases, ten refs listed: the producer truncates at
    // RETIRED_REF_CAP and SAYS SO rather than slicing silently.
    { name: 'Demo Pensacola Legacy Practices', live_rows: 1, refs: ['P-911'], retired_aliases: 12, retired_refs: ['P-912', 'P-913', 'P-914', 'P-915', 'P-916', 'P-917', 'P-918', 'P-919', 'P-920', 'P-921'], retired_refs_truncated: true, live_as_role: 0, role_refs: [], all_retired: false },
  ];

  const searchDeals = [
    { name: 'Demo Pensacola distribution warehouse', phase: 'pending', owner: null, client_ref: 'C-902' },
    // TWO deals sharing a name. The producer does NOT deduplicate deals when it
    // derives candidates, and a fixture that did would certify a client that
    // silently drops one of them.
    { name: 'Demo Pensacola medical office building', phase: 'research', owner: 'joe', client_ref: null },
    { name: 'Demo Pensacola medical office building', phase: 'legal', owner: 'dell', client_ref: 'C-902' },
  ];

  const searchConnections = [
    { from_ref: 'P-906', from_name: 'Demo Pensacola Surgical Suites', kind: 'refers_to', to_ref: 'L-901', to_name: 'Demo Pensacola Family Dentistry', note: 'introduced at a demo society meeting' },
    { from_ref: null, from_name: 'Demo Pensacola Referring Physician', kind: 'works_with', to_ref: 'C-902', to_name: 'Demo Pensacola Orthopedic Partners', note: null },
  ];

  /** Each of the three `link_basis` values the producer can report. */
  const searchLeadClientLinks = [
    { lead_ref: 'L-901', lead_name: 'Demo Pensacola Family Dentistry', client_ref: 'C-902', client_name: 'Demo Pensacola Orthopedic Partners', link_basis: 'conversion' },
    { lead_ref: 'L-905', lead_name: 'Demo Specialty Center Of Pensacola', client_ref: 'C-902', client_name: 'Demo Pensacola Orthopedic Partners', link_basis: 'same_party' },
    { lead_ref: 'L-904', lead_name: 'Demo Pensacola Smiles (retired alias)', client_ref: 'C-902', client_name: 'Demo Pensacola Orthopedic Partners', link_basis: 'same_org' },
  ];
  const searchDealsViaLink = [
    { name: 'Demo Pensacola distribution warehouse', phase: 'pending', client_ref: 'C-902', link_basis: 'conversion' },
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
    // Deals are NOT deduplicated. Two deals with one name are two candidates.
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
        participants: [{ role: 'lead', name: actorLabel(deal.owner), actor: deal.owner },
          ...(extraParticipants.get(dealId) || [])],
        premises: [], negotiation_rounds: [], documents: [] };
    },

    // V5-UX-B04: fixture stand-in for the pinned `/api/v1/business/{dataset}/<id>`
    // single-record read. A genuinely unknown id (d02's account_client_id, on
    // purpose) throws, exactly as a live 404 would, so callers exercise the
    // real fetch-failure branch rather than a synthetic one.
    async getPartyRecord({ dataset, id }) {
      const record = businessRecords.get(id);
      if (!record) throw new Error(`fixture business record not found: ${dataset}/${id}`);
      return { viewer: selfActor, dataset, record: { ...record } };
    },

    async getJevDealReading() {
      return { schema: 'carr.jev-deal-reading.v1', judged: false, reason: 'jev_unavailable' };
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

    // `change_reason` and `human_quote` are optional at the record layer and are
    // optional here: a move without them is not refused, it simply records none.
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
          refuse('update-deal', 'version_conflict', { deal, resolution: 're-read the deal and decide from what it holds now' });
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
      // V5-UX-C13a's enriched cards are checked FIRST and are a strict
      // addition: WR-000901..905 below are untouched and keep answering the
      // sparse shape V5-UX-B10a already tests.
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

    // ------------------------------------------------------ Control Room (C01)
    // The synthetic twins of the three Control Room reads, in the record
    // layer's OWN row vocabulary: an incident's recurrence count is
    // `occurrences`, its age is `age_days`, its recommended next step is
    // `next_action`, and held work carries `hours_since_last_change` with a
    // blocker object or an explicit null. A fixture that invented friendlier
    // names would let the page work here and fail against CARR.
    //
    // `outage` is the switch that makes CR-AC-02 demonstrable in a browser:
    // exactly one read throws, and the page must then make only that read's
    // areas unknown. It is fixture-only and cannot exist on a reviewed host.
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

    // ------------------------------------------------- incident detail (C14)
    // `get-incident` keeps facts and hypotheses apart, so this does too. An
    // unknown reference is `incident_not_found`, the ledger's own code, rather
    // than an empty detail that would look like an incident with nothing in it.
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
      };
    },

    // The one write the incident page offers. It validates exactly the two
    // patterns the verb declares, refuses a link that already exists, and
    // replays under a reused key like every other fixture write.
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

    // ----------------------------------------------- notifications (B12a)
    // `notification-feed` takes NO recipient: the feed function resolves the
    // caller itself, so a recipient argument is unreachable here exactly as it
    // is unreachable through the verb's closed schema. `unread_count` is
    // counted over EVERY row the recipient holds, while the list is capped at
    // `limit` — a fixture that counted the visible rows instead would let a
    // page recompute the number and still pass.
    async notificationFeed({ after = null, limit = 50 } = {}) {
      refuseIfOutage('notifications', 'notification-feed');
      const capped = clampLimit(limit);
      const rows = notifications
        .filter((row) => (after ? String(row.created_at) > String(after) : true))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, capped);
      // `quiet_now` and `quiet_suppressed` are OUTPUT-ONLY, exactly as the
      // producer emits them, and `quiet_suppressed` is the same DISJUNCTION:
      // quiet hours across now, OR a push the store already recorded as
      // suppressed. A fixture that used only the second term would let a page
      // pass while ignoring the live window.
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

    // The preference read. It takes NO arguments, and it is spelled with no
    // parameter list at all so an argument cannot be added here by accident:
    // the verb declares zero properties under additionalProperties:false.
    // ------------------------------------ session identity and dispatch (S02)
    // Both are READS and neither takes an actor, exactly as the verbs declare.
    // `total_seen` and `total_returned` are the production numbers and do NOT
    // move with `limit` — that is what makes the three-number counts line
    // testable here instead of only against production.
    async sessionIdentity({ query = null, limit = null, include_closed = false } = {}) {
      refuseIfOutage('sessions', 'read-session-identity');
      const text = typeof query === 'string' ? query.trim().toLowerCase() : '';
      // `include_closed` is passed through to the producer and changes nothing
      // here: no captured row carries a closed state, so a fixture that made the
      // toggle move rows would be inventing a corpus production did not return.
      void include_closed;
      // BOTH fields, because clause 1 is "name/ID lookup" and a fixture that
      // matched on the name alone would let an id lookup pass while broken.
      const matched = text.length === 0
        ? SESSION_ROWS
        : SESSION_ROWS.filter((row) => String(row.display_name).toLowerCase().includes(text)
          || String(row.canonical_session_id).toLowerCase().includes(text));
      if (text === 'reverent') {
        // The captured FILTERED-EMPTY answer: four rows match and none is the
        // caller's to see. An empty list with permission_filtered true.
        return { ok: true, permission_filtered: true, total_seen: 4, total_returned: 0, sessions: [] };
      }
      if (matched.length === 0) {
        // The captured GENUINELY-EMPTY answer: nothing matched at all.
        return { ok: true, permission_filtered: false, total_seen: 0, total_returned: 0, sessions: [] };
      }
      const capped = Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : 25;
      const page = matched.slice(0, capped);
      // 603 and 124 are production's own numbers for the unfiltered page, and
      // they do NOT shrink when `limit` does.
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

    async dispatchHistory({ session_id, cursor = null, limit = null } = {}) {
      refuseIfOutage('sessions', 'read-dispatch-history');
      void cursor;
      void limit;
      if (session_id === SESSION_WITH_DISPATCH) {
        return structuredClone(DISPATCH_WITH_EVENTS);
      }
      // Every other id — real, synthetic or nonsense — answers identically,
      // which is precisely why the drawer never says "this session has none".
      return dispatchNoSpine(String(session_id));
    },

    // ------------------------------- Model Room assignments and turns (C12)
    // Synthetic twins of the two captured answers, in the PRODUCER'S OWN shape.
    // `live` is false and `projected_at` is old, because that is what the real
    // queue answers: a fixture that made the projection fresh would let a page
    // pass while the stale branch — the ordinary one — was never drawn. The
    // room argument is honoured exactly as the producer honours it, so reading
    // the queue from `model-room` here answers empty, as it does in production.
    async roomQueue({ room = 'partner-line' } = {}) {
      refuseIfOutage('model_room', 'read-room-queue');
      if (room !== 'partner-line') {
        // Nothing has EVER been projected into that room: projected_at null,
        // which is a different truth from a stale projection.
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
        // A bigint, serialised by the driver as a decimal STRING, exactly as
        // production returns it. A fixture that made it a number would let a
        // validator demanding an integer pass here and refuse production.
        latest_seq: turns.length ? String(turns[turns.length - 1].seq) : '0',
        more: turns.length === capped,
      };
    },

    async notificationPreferences() {
      refuseIfOutage('notifications', 'read-notification-preferences');
      return { ...preferencePayload(), quiet_now: quietNow() };
    },

    // The preference write, refusing what the record layer refuses, IN ORDER
    // and every refusal before any change — 0527's four ordered refusals, then
    // the compare-and-swap. `version_conflict` carries `current_version`, which
    // is what lets the page re-read and say what happened instead of retrying.
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
          refuse('set-notification-preference', 'version_conflict', { current_version: preference.version });
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

    // The one write this page offers, refusing what the record layer refuses.
    // A malformed id and an id addressed to somebody else are the SAME code,
    // `notification_not_found`, because the feed function answers both the same
    // way and a friendlier fixture would teach the page a distinction that does
    // not exist. A second acknowledgement is not a refusal: it returns
    // `deduplicated: true` carrying the FIRST `read_at`, and moves nothing.
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

    // ------------------------------------------ Doc conversations (V5-UX-B07)
    // One read and three writes, refusing what the record layer refuses. The
    // read's THREE not-found cases return the same code deliberately; the
    // rename's creator-only refusal is raised BEFORE the compare-and-swap, so a
    // refused rename leaves the row's version exactly where it was; and
    // `create`'s idempotency key BECOMES the conversation id, so a second key
    // would be a second conversation rather than a retry.
    async readDocConversation({ conversation_id, after_sequence = null, limit = 50 } = {}) {
      refuseIfOutage('conversations', 'read-doc-conversation');
      const id = String(conversation_id || '');
      const row = DOC_UUID.test(id) ? docConversations.get(id) : null;
      if (!row || !docVisibleTo(row, selfActor)) refuse('read-doc-conversation', 'doc_conversation_not_found');
      // The store's own clamps and its own predicate, copied rather than
      // approximated: `least(greatest(coalesce(p_limit,200),1),200)` (0520:181),
      // `greatest(coalesce(p_after_sequence,0),0)` (0520:182), and the page
      // selection `where sequence >= v_after` (0520:198) — INCLUSIVE. A fixture
      // that paged exclusively would certify a client that duplicates a turn.
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
      // The store's own clamp: 1..100, defaulting when unnamed.
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

    // ------------------------------------------------ global search (V5-UX-B05)
    // Two READS, refusing exactly what the live verbs refuse. Neither names an
    // actor, a tenant or a kind: `find` declares ONE property and
    // `find-and-catch-up` declares two under additionalProperties:false, and a
    // third key is refused by the gateway before either handler runs. A no-match
    // is a 200 with six empty arrays and the note — never an error.
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
            ? 'Only retired aliases matched; no live record stands behind this name.'
            : 'No live record matched this name.',
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
        // ONE HEADER ROW AND NO GRANT. `ops.create_doc_conversation` is a single
        // insert into `ops.doc_conversation` (0523:75-78) and touches
        // `ops.doc_conversation_grant` nowhere. A conversation created `shared`
        // is a header that SAYS shared with an EMPTY grant list, and the read
        // door gates on creator-or-unrevoked-grant (0520:186-189), so the
        // partner is refused until somebody explicitly shares it with him.
        // Minting a grant here would show a partner, in demo mode, holding a
        // read that production refuses him.
        //
        // The key IS the id. That is the store's own rule, and it is what makes
        // a replay of the retained request a retry instead of a second row.
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
          refuse(verb, 'version_conflict', { conversation_id: id, current_version: row.version });
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

    async currentWorkRequests() {
      refuseIfOutage('needs_joe', 'current-work-requests');
      return { ok: true, items: sharedRequests.map((row) => ({ ...row, source: { ...row.source } })) };
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

    // Mirrors the record layer's revert-deal-field verb: the reverted event
    // IS the base (no separate base_event_id argument), a missing event or a
    // field outside BASED_FIELDS is `event_not_revertible`, and — the check
    // that matters for an undo — it refuses `newer_change_exists` unless the
    // event being reverted is still the LATEST event on that deal+field. A
    // successful revert is a canonical correction: it pushes a new event
    // (verb `revert-deal-field`) rather than rewriting history in place, so
    // it appears on the change feed and advances lastFieldEvent exactly as a
    // live revert would.
    async revertDealField({ event_id, idempotency_key }) {
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
