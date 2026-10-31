import { validEmailDraftReceipt } from './email-draft.js';
import { sessionFetch } from './private-session.js';
import { PHASE_BY_SLUG } from './client.js';
import { requireReviewReceipt } from './deal-review-model.js';
/**
 * Live client: same interface as fixture, against the deployed Worker.
 * Verbs travel as MCP JSON-RPC tools/call over the cookie-authenticated /mcp
 * mount; the event cursor is plain GET /pipeline/changes. Both are same-origin
 * on each reviewed Deal Room host, so no baseUrl is needed in production or
 * staging; one may be passed directly for isolated client tests.
 */
import { uuidv4 } from './uuid.js';
import { readinessRequest, threadRequest } from './correspondence-model.js';
import { fetchRead, readWithDeadline } from './current-read.mjs';
import { createMcpRequests, unknownMcpOutcome } from './mcp-requests.mjs';
import { observeDocClient } from './doc-context.js';
import { expandBoardRead } from './progress-board-model.js';
import { createEngagementWriter } from './prospect-engagement.mjs';
import { createRetainedCommands } from './retained-commands.mjs';

// Verified pre-commit refusals from new-deal and its argument/subject checks
// in CARR producer 0cc6fe2538a81521bf8c25b0df58aa4063ed614b. Internal and
// unrecognized errors can follow a committed write; retain those for replay.
const CREATION_REFUSALS = new Set([
  'missing_required', 'subject_not_found', 'needs_disambiguation', 'not_a_client',
  'deal_name_exists', 'salesforce_id_in_use', 'unknown_deal_type',
  'unknown_phase', 'unknown_lane',
]);

/**
 * @param {Object} [opts]
 * @param {string} [opts.baseUrl] same-origin by default; override for dev
 * @param {string} [opts.selfActor]
 * @param {(path:string, init?:RequestInit)=>Promise<Response>} [opts.fetchImpl]
 * @param {()=>boolean} [opts.online] connection signal; injectable in tests
 */
// Concurrent identical page reads (Home's layout, Doc and the morning brief all ask
// for the same board) share one request. Nothing is cached once it settles.
const sharedReads = new WeakMap();
const SHARED_READ_VERBS = new Set(['deal-room-board', 'morning-brief', 'list-feature-switches']);

export function createLiveClient(opts = {}) {
  const baseUrl = (opts.baseUrl || '').replace(/\/$/, '');
  let selfActor = opts.selfActor || null;
  const fetchImpl = opts.fetchImpl || ((path, init) => sessionFetch(`${baseUrl}${path}`, init));
  const online = opts.online || (() => globalThis.navigator?.onLine !== false);
  const requestMcp = createMcpRequests({ fetchImpl, typedContent: false });
  const dealCreations = new Map();
  const fetchReadImpl = (path, init) => fetchRead(path, init, { fetchImpl, timeoutMs: opts.readTimeoutMs || 10_000 });
  const commands = createRetainedCommands({ scope: () => selfActor });
  const sessionCommands = createRetainedCommands({ scope: async () => {
    const response = await fetchReadImpl('/auth/session', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) throw Object.assign(new Error('Sign in again before checking this write.'), { status: response.status });
    const session = await response.json();
    if (typeof session?.actor?.slug !== 'string' || typeof session.csrf_token !== 'string' || !session.csrf_token)
      throw new Error('The current session could not be verified. No write was sent.');
    if (selfActor && selfActor !== session.actor.slug) throw Object.assign(new Error('Session changed. Reopen the record before writing.'), { code: 'session_changed' });
    return `${session.actor.slug}:${session.csrf_token}`;
  } });
  const sessionWrites = new Set(['set-next-step', 'set-market-agent', 'set-national-account-owner', 'create-national-account',
    'create-national-market-deal', 'start-deal-review', 'review-deal', 'end-deal-review',
    'resolve-candidate', 'resolve-post-call-candidate', 'answer-work-request-for-joe', 'add-industry-event', 'update-industry-event',
    'undo-call-change', 'review-call-outcome', 'confirm-email-next-step', 'confirm-email-deal-progress', 'dismiss-email-proposal', 'submit-email-draft', 'register-client-portal', 'record-human-fact', 'resolve-fact-review', 'adopt-rule']);

  const readTimeoutMs = opts.readTimeoutMs || 10_000;
  const rpc = (verb, args = {}, signal) => {
    if (!SHARED_READ_VERBS.has(verb)) return rawRpc(verb, args, signal, readTimeoutMs);
    if (signal?.aborted) return readWithDeadline(() => null, { signal, timeoutMs: readTimeoutMs });
    const transport = opts.fetchImpl || sessionFetch;
    if (!sharedReads.has(transport)) sharedReads.set(transport, new Map());
    const reads = sharedReads.get(transport), key = JSON.stringify([baseUrl, selfActor, verb, args, readTimeoutMs]);
    let entry = reads.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, waiters: 0 };
      const current = entry;
      entry.read = rawRpc(verb, args, controller.signal, readTimeoutMs).finally(() => {
        if (reads.get(key) === current) reads.delete(key);
      });
      entry.read.catch(() => {});
      reads.set(key, entry);
    }
    const shared = entry;
    shared.waiters++;
    const release = () => {
      signal?.removeEventListener('abort', release);
      if (--shared.waiters === 0 && reads.get(key) === shared) { reads.delete(key); shared.controller.abort(); }
    };
    signal?.addEventListener('abort', release, { once: true });
    return readWithDeadline(() => shared.read.then(structuredClone), { signal, timeoutMs: readTimeoutMs })
      .finally(() => { if (!signal?.aborted) release(); });
  };

  async function rawRpc(verb, args = {}, signal, timeoutMs, headers) {
    const outcome = await requestMcp(verb, args, { signal, timeoutMs, headers });
    if (outcome.kind === 'authorization' || outcome.reason === 'http') {
      const error = new Error(`live ${verb} -> HTTP ${outcome.status}`);
      error.status = outcome.status;
      if (outcome.kind !== 'authorization') error.body = outcome.body;
      throw error;
    }
    if (outcome.kind === 'unconfirmed') {
      if (outcome.reason === 'rpc') throw new Error(`live ${verb} rpc error: ${outcome.cause.message}`);
      if (['network', 'deadline', 'envelope', 'payload'].includes(outcome.reason)) throw outcome.cause;
      throw unknownMcpOutcome(outcome.cause);
    }
    const { payload, isError } = outcome;
    if (isError || (payload?.error && payload.ok !== true)) {
      const err = new Error(`live ${verb} refused: ${payload?.error || 'tool_error'}`);
      err.payload = payload;
      if (verb === 'new-deal') err.creationStage = 'new-deal';
      err.writeRefusal = verb === 'new-deal' && CREATION_REFUSALS.has(payload?.error);
      throw err;
    }
    if (['list-fact-review', 'record-human-fact', 'resolve-fact-review'].includes(verb) && (payload?.ok !== true || payload.schema_version !== 'fact-review.v1'))
      throw unknownMcpOutcome(new Error('Term review receipt unavailable'));
    if (verb === 'record-human-fact' && !payload?.observation?.id)
      throw unknownMcpOutcome(new Error('Recorded term receipt unavailable'));
    if (verb === 'resolve-fact-review' && (!Object.hasOwn(payload, 'canonical_fact') || payload.review_receipt?.decision !== args.decision))
      throw unknownMcpOutcome(new Error('Term decision receipt unavailable'));
    if (verb === 'adopt-rule' && (payload?.ok !== true || !payload.rule_id || payload.retired_section_id !== args.section_id))
      throw unknownMcpOutcome(new Error('Adoption receipt unavailable'));
    if (verb === 'start-deal-review') requireReviewReceipt(payload);
    if (['confirm-email-next-step', 'confirm-email-deal-progress'].includes(verb)) {
      const contract = verb === 'confirm-email-next-step' ? 'email-next-step.v1' : 'email-deal-progress.v1';
      if (payload?.contract !== contract || payload.status !== 'confirmed' || payload.requires_confirmation !== false
        || payload.deal !== args.deal || payload.source?.activity_id !== args.activity_id || payload.proposal_digest !== args.proposal_digest)
        throw unknownMcpOutcome(new Error('Email confirmation receipt unavailable'));
      return { ...payload, ok: true };
    }
    if (verb === 'submit-email-draft' && !validEmailDraftReceipt(payload, args))
      throw unknownMcpOutcome(new Error('Reply submission receipt unavailable'));
    return payload;
  }

  async function write(verb, args, timeoutMs) {
    // A disconnected app may keep local drafts, but must never attempt a
    // canonical write. The caller retains the same request for reconciliation.
    if (!online()) {
      const error = new Error('Offline. Reconnect and review before saving.');
      error.payload = { error: 'offline' };
      throw error;
    }
    // Existing command/form callers already retain their reviewed request.
    // Keep those domain receipt contracts intact; cover the unretained paths
    // and the old fallback that minted a different key on every attempt.
    if (args.idempotency_key && !sessionWrites.has(verb)) return rawRpc(verb, args, undefined, timeoutMs);
    const target = ['proposal_id', 'activity_id', 'deal', 'candidate_id', 'account_client_id', 'event_id', 'human_ref', 'session_id',
      'section_id', 'entity_ref', 'fact_key', 'loop_id', 'conversation_id', 'suggestion_id', 'commission_id', 'board_id', 'client_id', 'field', 'projection_id']
      .filter(key => args[key] !== undefined).map(key => [key, args[key]]);
    const operationKey = JSON.stringify([verb, target]);
    const retained = sessionWrites.has(verb) ? sessionCommands : commands;
    return retained.send(operationKey, args, (request, binding) => rawRpc(verb, request, undefined, timeoutMs || opts.writeTimeoutMs || 10_000,
      sessionWrites.has(verb) ? { 'x-carr-csrf': binding.slice(binding.indexOf(':') + 1) } : undefined));
  }

  // CARR phase slugs and board labels map one-to-one in both directions.
  const PHASE_TO_UI = PHASE_BY_SLUG;
  const UI_TO_PHASE = {
    'On Deck': 'pending', 'Research': 'research', 'Site selection': 'site_selection',
    'Negotiation': 'negotiation', 'Legal': 'legal', 'Diligence': 'due_diligence',
    'Closing': 'closing', 'Closed': 'closed',
  };
  const TYPE_TO_UI = {
    startup: 'Startup', relocation: 'Relocation', additional_office: '2nd Office',
    renewal: 'Renewal', expansion: 'Expansion', purchase: 'Purchase', other: 'Other',
  };
  // Chip text, built from the candidate's own fields. A proposal must read as
  // a question about a specific deal, and it must never look like something
  // that already happened.
  function confirmLabel(c) {
    const who = c.deal_name || c.payload?.deal || 'this deal';
    const p = c.payload || {};
    if (c.kind === 'phase_move') return `${who} → phase ${PHASE_TO_UI[p.value] || p.value}?`;
    if (c.kind === 'next_step') return `${who} → next step "${p.text || ''}"?`;
    if (c.kind === 'new_deal') return `New deal "${p.name || 'untitled'}" — create?`;
    if (c.kind === 'meeting_record') return 'File the meeting summary?';
    return `${who} — log ${p.kind || 'activity'}?`;
  }

  const dealToUi = (d) => ({
    ...d,
    phase: PHASE_TO_UI[d.phase] || d.phase,
    type: TYPE_TO_UI[d.type] || d.type,
    next_step: d.next_step || '',
    market: d.market ?? d.city ?? '',
    version: d.version ?? d.base_version,
  });

  const client = {
    mode: /** @type {const} */ ('live'),
    get selfActor() { return selfActor; },
    async readAssuranceHealth(args) { const { assuranceHealthRequest } = await import('./assurance-health-model.js'); return rpc('read-assurance-health', assuranceHealthRequest(args)); },
    async getRelationshipNetwork({ signal } = {}) {
      const response = await fetchReadImpl('/api/v1/business/relationships?contract=relationship-network.v1', {signal,credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'}});
      if (!response.ok) throw Object.assign(new Error('Relationships unavailable'), {status:response.status});
      return response.json();
    },
    async updateVendorTrust(args) { return write("update-vendor", args); },
    async correspondenceReadiness(args = {}) { return rpc('correspondence-readiness', readinessRequest(args)); },
    async readCorrespondenceThread(args) { return rpc('read-correspondence-thread', threadRequest(args)); },

    // Each deal carries `field_base` — the latest committed event id and time for
    // every editable cell, read in the same statement as the values it belongs
    // to. It passes through untouched: it is the record layer's own identity for
    // an event, in the record layer's own field vocabulary, and translating or
    // rebuilding it would be inventing one.
    async readMarketTerms(args) {
      const response = await fetchReadImpl('/api/v1/market-terms/read', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify(args) });
      if (!response.ok) throw Object.assign(new Error('Market terms unavailable'), {status:response.status});
      return response.json();
    },
    async getInvoiceTracker({ signal } = {}) { return rpc('read-invoice-tracker', {}, signal); },
    async markInvoicePaid(args) { return write('record-commission-receipt', args, opts.writeTimeoutMs || 10_000); },
    async getHomeAgenda({ signal } = {}) {
      const agenda = await rpc('read-home-agenda', {}, signal);
      selfActor = agenda.actor || selfActor;
      return { ...agenda, deals: Array.isArray(agenda.deals) ? agenda.deals.map(dealToUi) : agenda.deals };
    },
    async getPostCallFollowups({ signal } = {}) { return rpc('read-post-call-followups', {}, signal); },

    async getBoard(options = {}) {
      const board = await rpc('deal-room-board', {
        workspace: options.workspace || 'all',
        ...(options.account_client_id ? { account_client_id: options.account_client_id } : {}),
      }, options.signal);
      selfActor = board.actor || selfActor;
      return { ...board, deals: Array.isArray(board.deals) ? board.deals.map(dealToUi) : board.deals,
        lost_deals: Array.isArray(board.lost_deals) ? board.lost_deals.map(dealToUi) : undefined,
        closed_deals: Array.isArray(board.closed_deals) ? board.closed_deals.map(dealToUi) : undefined };
    },

    async listDealDocuments(args = {}, { signal } = {}) { return rpc('list-deal-documents', args, signal); },
    async prepareTermsComparison(args) {
      if (!online()) throw Object.assign(new Error('Offline'), { payload: { error: 'offline' } });
      return sessionCommands.send(JSON.stringify(['prepare-terms-comparison', args.deal_id]), args, async (request, binding) => {
        const { prepareComparisonHttp } = await import('./terms-comparison-http.mjs');
        return prepareComparisonHttp(fetchImpl, request, binding.slice(binding.indexOf(':') + 1), opts.writeTimeoutMs || 10_000);
      });
    },
    async listFactReview(args = {}, { signal } = {}) { return rpc('list-fact-review', args, signal); },
    async recordHumanFact(args) { return write('record-human-fact', args); },
    async resolveFactReview(args) { return write('resolve-fact-review', args); },

    async getDeal(dealId, { signal } = {}) {
      const page = await rpc('get-deal-room', { deal: dealId }, signal);
      const { thread = [], critical_dates = [], events = [], deal_id, ...fields } = page;
      // Canonical action fields win over historical notes. The newest note
      // is only a fallback for older producers without an action field.
      // Older next_step rows remain archived; notes pass through.
      const hasCanonicalStep = Object.hasOwn(fields, "next_step") || Object.hasOwn(fields, "next_action");
      const canonicalStep = fields.next_step ?? fields.next_action ?? "";
      let currentSeen = false;
      const uiThread = [];
      let currentStep = null;
      for (const n of thread) {
        if (n.kind === 'next_step') {
          if (!currentSeen) {
            currentSeen = true; currentStep = n.text;

          }
          uiThread.push({ ...n, kind: 'archived_step' });
        } else {
          uiThread.push(n);
        }
      }
      const history = events.map((e) => {
        for (const side of ['old_value', 'new_value']) {
          const v = e[side];
          if (v && typeof v === 'object' && e.field && e.field in v) e[side] = v[e.field];
        }
        const val = e.field === 'phase' && typeof e.new_value === 'string'
          ? (PHASE_TO_UI[e.new_value] || e.new_value) : e.new_value;
        const summary = e.field
          ? `${e.verb.replace(/-/g, ' ')} · ${e.field} → ${typeof val === 'string' ? val : JSON.stringify(val)}`
          : e.verb.replace(/-/g, ' ');
        return { ...e, summary };
      });
      return {
        deal: dealToUi({ id: deal_id, ...fields, next_step: hasCanonicalStep ? canonicalStep : (currentStep ?? '') }),
        thread: uiThread,
        critical_dates: critical_dates.map((cd) => ({ ...cd, label: cd.note || cd.kind, date: cd.due_on })),
        history,
        next_actions: page.next_actions || [],
        items: page.items || [],
        item_schema_version: page.item_schema_version,
        activities: page.activities || [],
        ...(Object.hasOwn(page, 'email_threads') ? { email_threads: page.email_threads } : {}),
        participants: page.participants || [],
        premises: page.premises || [],
        negotiation_rounds: page.negotiation_rounds || [],
        documents: page.documents || [],
        lease: page.lease ?? null,
        checklist: page.checklist ?? null,
        schema_version: page.schema_version,
      };
    },

    // The app sends only the deal id to CARR. CARR performs the bounded
    // on-demand TypeSafe call authorized by Joe in this task.
    async getJevDealReading(dealId) {
      const res = await fetchReadImpl('/api/v1/jev-deal-reading', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deal: dealId }),
      });
      if (!res.ok) throw new Error(`Jev deal reading unavailable (${res.status})`);
      return res.json();
    },

    // Use the client or vendor UUID, not a participant's party_id.
    // A failed read leaves the context drawer unavailable.
    async getPartyRecord({ dataset, id }) {
      const res = await fetchReadImpl(`/api/v1/business/${dataset}/${id}`, {
        headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store',
      });
      if (!res.ok) throw Object.assign(new Error(`live business ${dataset} record -> HTTP ${res.status}`), {status:res.status});
      return res.json();
    },

    // The confirm strip, live: proposals distilled from a recorded call. The
    // label is built here from the candidate's own shape, never from a
    // server-supplied string, and every disposition goes through
    // resolve-candidate, which is the only thing that writes.
    async getPendingConfirms() {
      const { candidates = [] } = await rpc('capture-queue', {});
      return {
        proposals: candidates.map((c) => ({
          id: c.id,
          deal_id: c.payload?.deal || null,
          label: confirmLabel(c),
        })),
      };
    },

    async getCallContext({ deal_ids }) {
      return rpc('get-call-context', { deal_ids });
    },

    async resolveConfirm({ proposal_id, accept, idempotency_key }) {
      const res = await write('resolve-candidate', {
        candidate_id: proposal_id,
        accept,
        idempotency_key,
      });
      return { status: 'ok', event: null, ref: res?.ref || null };
    },

    async resolvePostCallCandidate({ candidate_id, accept, idempotency_key }) {
      return write('resolve-post-call-candidate', { candidate_id, accept, idempotency_key });
    },

    async listEmailProposals(args = {}) { return rpc('list-email-proposals', args); },
    async previewEmailNextStep(args) { return rpc('preview-email-next-step', args); },
    async previewEmailDealProgress(args) { return rpc('preview-email-deal-progress', args); },
    async confirmEmailFiling(args) { return write('confirm-email-filing', args); },
    async confirmEmailNextStep(args) { return write('confirm-email-next-step', args); },
    async confirmEmailDealProgress(args) { return write('confirm-email-deal-progress', args); },
    async submitEmailDraft(args) { return write('submit-email-draft', args); },
    async dismissEmailProposal(args) { return write('dismiss-email-proposal', args); },
    async listEmailThreadFilings() { return rpc('list-email-thread-filings', {}); },
    async undoEmailThreadFiling(args) { return write('undo-email-thread-filing', args); },

    async readCallOutcomes() {
      return rpc('read-call-outcomes', {});
    },

    async undoCallChange({ candidate_id, base_version }) {
      return write('undo-call-change', { candidate_id, base_version });
    },

    async reviewCallOutcome({ session_id }) {
      return write('review-call-outcome', { session_id });
    },

    async getChanges(cursor, { signal, since } = {}) {
      // Versioned pipeline keyset format. Starting at a clock cutoff avoids
      // replaying years of history; subsequent cursors remain server-issued.
      if (!cursor && since) {
        const timestamp = new Date(since).toISOString();
        cursor = btoa(JSON.stringify({ recorded_at:timestamp, id:'00000000-0000-0000-0000-000000000000' }))
          .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      }
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const data = await readWithDeadline(async currentSignal => {
        const res = await fetchImpl(`/pipeline/changes${q}`, { credentials: 'same-origin', signal:currentSignal });
        // Refusal is decided by the headers. Its diagnostic body must not
        // turn a known authorization failure into a statusless read failure.
        if (!res.ok) throw Object.assign(new Error(`live changes -> ${res.status}`), { status: res.status });
        return res.json();
      }, { signal, timeoutMs:opts.readTimeoutMs || 10_000 });
      for (const e of data.events || []) {
        if (e.field === 'client_id') e.move_name = e.new_value?.client_name || e.new_value?.name;
        // The event log stores values wrapped as {field: value}; the app (and
        // the fixture) speak bare values. Unwrap, then translate phase slugs.
        for (const side of ['old_value', 'new_value']) {
          const v = e[side];
          if (v && typeof v === 'object' && e.field && e.field in v) e[side] = v[e.field];
        }
        // BOTH sides, through the one table above. A change receipt states what
        // the value WAS as well as what it became, and a prior phase left as a
        // record-layer slug names a phase no surface has ever shown: the board
        // says "Diligence", never "due_diligence" — and never "Due diligence"
        // either, which is what a generic slug-humanizer would produce.
        if (e.field === 'phase') {
          for (const side of ['old_value', 'new_value']) {
            if (typeof e[side] === 'string') e[side] = PHASE_TO_UI[e[side]] || e[side];
          }
        }
      }
      return data;
    },

    async presenceLease({ deal, field, idempotency_key }) {
      return write('presence-lease', { deal, field, idempotency_key });
    },

    async patchDealField(args) {
      if (args.field === 'phase' && UI_TO_PHASE[args.value]) {
        args = { ...args, value: UI_TO_PHASE[args.value] };
      }
      // `change_reason` and `human_quote` ride through untouched: the partner's
      // own words are sent to CARR verbatim, never composed or reshaped here.
      // `event_id` / `event_recorded_at` ride through on the ok answer: the
      // record's own identity for the event this write committed, which is what
      // lets the board advance that cell's base without waiting a poll for the
      // feed to say the same thing. Nothing is derived here.
      const res = await write('patch-deal-field', args);
      if (res?.ok === false && res.conflict) {
        const c = res.conflict;
        return { status: 'conflict', conflict: {
          conflict_id: c.id,
          deal: c.deal_id,
          field: c.field,
          a: { actor: c.actor_a, value: c.value_a },
          b: { actor: c.actor_b, value: c.value_b },
        } };
      }
      return { status: 'ok', ...res };
    },

    async resolveConflict(args) {
      return write('resolve-conflict', args);
    },

    // The deal-row write the Closed column needs: the outcome and its date.
    // `base_version` is NOT defaulted and NOT re-read here — the caller reads
    // the deal, decides against what it read, and sends that version. A client
    // that fetched a fresh version on the caller's behalf would turn a crossed
    // edit into a silent overwrite. `fields` passes through untouched except
    // for the phase vocabulary, which this verb does not carry.
    async updateDeal(args) {
      return write('update-deal', args);
    },

    async recordDealItem(args) { return write('record-deal-item', { ...args, source_ref: args.source_ref || `app:deal-item:${args.idempotency_key}` }); },
    async instructDealItem(args) { return write('instruct-deal-item', args); },
    async completeDealItem(args) { return write('complete-deal-item', args); },
    // The portal password goes to CARR once, here; CARR keeps only a verifier and answers with the link.
    async registerClientPortal(args) {
      return write('register-client-portal', args);
    },

    async addDealNote(args) {
      return write('add-deal-note', args);
    },

    async logActivity(args) { return write('log-activity', args); },

    async setNextStep(args) {
      return write('set-next-step', args);
    },

    // A date that matters to the record, with the place it came from. `source`
    // is not optional at the record layer and is not defaulted here: a date
    // whose provenance nobody stated is one this app will not invent one for.
    async addCriticalDate(args) {
      return write('add-critical-date', args);
    },

    async createDeal(args) {
      const key = args.idempotency_key || uuidv4();
      const request = {
        client: args.client,
        name: args.name,
        deal_type: args.deal_type || 'other',
        phase: UI_TO_PHASE[args.phase] || args.phase || 'pending',
        segment: args.segment || undefined,
        city: args.market || undefined,
        lane: args.lane || 'territory',
        reason: 'Created in the Deal Room',
        idempotency_key: key,
      };
      const intent = { ...request, owner: args.owner || selfActor, notes: args.notes || '' };
      let operation = dealCreations.get(key);
      if (operation && JSON.stringify(operation.intent) !== JSON.stringify(intent)) throw new Error('Reconcile the original deal creation before changing its fields.');
      if (!operation) {
        operation = { request, intent, actor: intent.owner };
        dealCreations.set(key, operation);
      }
      if (operation.result) return operation.result;
      if (operation.inFlight) return operation.inFlight;
      operation.inFlight = (async () => {
        let res = operation.receipt;
        if (!res) {
          try { res = await write('new-deal', operation.request); }
          catch (error) {
            // Only a verified first creation refusal proves no deal was made.
            // A refusal after an uncertain attempt cannot retire that intent.
            if (error.writeRefusal && !operation.creationUncertain) {
              dealCreations.delete(key);
              error.creationRefused = true;
            } else operation.creationUncertain = true;
            throw error;
          }
        }
        if (typeof res?.deal_id !== 'string' || !res.deal_id.trim()) {
          operation.creationUncertain = true;
          throw new Error('Created deal receipt is unavailable. Reconcile the same request.');
        }
        operation.receipt = res;
        if (!operation.lead) {
          const fresh = await rpc('get-deal-room', { deal: res.deal_id });
          if (!Number.isInteger(fresh?.base_version)) throw new Error('Created deal version is unavailable; lead was not assigned.');
          operation.lead = { deal: res.deal_id, new_lead: operation.actor, base_version: fresh.base_version, idempotency_key: uuidv4() };
        }
        if (!operation.leadConfirmed) {
          const lead = await write('set-lead', operation.lead);
          if (lead?.ok !== true) throw new Error('Lead receipt is unavailable. Reconcile the same request.');
          operation.leadConfirmed = true;
        }
        if (intent.notes && !operation.noteConfirmed) {
          operation.note ||= { deal: res.deal_id, text: intent.notes, idempotency_key: uuidv4() };
          const note = await write('add-deal-note', operation.note);
          if (note?.ok !== true) throw new Error('Note receipt is unavailable. Reconcile the same request.');
          operation.noteConfirmed = true;
        }
        operation.result = { status: 'ok', deal_id: res.deal_id };
        return operation.result;
      })();
      try { return await operation.inFlight; } finally { operation.inFlight = null; }
    },

    // ---------------------------------------------------------------- loops
    // Task records are loop records. The reads pass their arguments through
    // untouched, and the writes keep the caller's idempotency key: the command
    // kernel mints one key per logical operation and a client that replaced it
    // would turn a reconcile into a second write.
    //
    // `read-loop` answers a miss IN the payload with `isError` false, so a
    // not_found or an ambiguous number arrives here as an ordinary answer and
    // is returned as one. Only a real refusal throws.
    async loopBoard(args = {}, { signal } = {}) { return rpc('loop-board', args, signal); },
    async readLoop(args = {}) { return rpc('read-loop', args); },
    async loopHeaders(args = {}) { return rpc('loop-headers', args); },
    async addLoop(args) { return write('add-loop', args); },
    async updateLoop(args) { return write('update-loop', args); },
    async closeLoop(args) { return write('close-loop', args); },

    // Industry events are tenant-scoped by CARR. The version used for an edit
    // comes from listIndustryEvents; this adapter never guesses a newer one.
    async listIndustryEvents(args = {}) { return rpc('list-industry-events', args); },
    async addIndustryEvent(args) { return write('add-industry-event', args); },
    async updateIndustryEvent(args) { return write('update-industry-event', args); },

    // Authenticated sponsor is resolved by CARR; callers cannot select a partner.
    async listFeatureSwitches({ signal } = {}) { return rpc('list-feature-switches', {}, signal); },
    async calendarMeetingPrep({ signal } = {}) { return rpc('calendar-meeting-prep', {}, signal); },
    async morningBrief({ signal, fresh } = {}) { return fresh ? rawRpc('morning-brief', {}, signal, readTimeoutMs) : rpc('morning-brief', {}, signal); },
    async morningBriefQueue(queue, {cursor,signal} = {}) {
      if (!['today','loops','needs_joe','assurance_cadence'].includes(queue)) throw new Error('Unsupported morning queue.');
      return rpc(queue === 'assurance_cadence' ? 'morning-assurance-queue' : 'morning-brief-queue',
        {...(queue === 'assurance_cadence' ? {} : {queue}),...(cursor === undefined ? {} : {cursor})},signal);
    },

    // ------------------------------------------------------------- triage
    // V5-UX-B01 — Home's This week. The verb takes no arguments, so none are
    // sent: which rows are due is the record layer's decision, not the page's.
    async todayTriage() { return rpc('today-triage', {}); },

    // ---------------------------------------------------------- command centre
    // The one aggregate Home read. It is NOT an MCP verb: the app Worker serves
    // it as a cookie-authenticated same-origin GET, and the only query parameter
    // it accepts is a viewer equal to the session actor, so this client sends
    // none and lets the session say who is asking.
    //
    // The STATUS travels on the error. A 401 or 403 is a decision taken before
    // the read ran and the page must say the session ended; anything else is a
    // path failure the page may retry. A caller that saw only a thrown Error
    // could not tell those apart.
    async commandCenter() {
      const res = await fetchReadImpl('/api/v1/command-center', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) {
        const error = new Error(`live command-center -> HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return res.json();
    },

    // ------------------------------------------------- delivery evidence (C11)
    // Three reads and three writes, passed through untouched. The reads answer a
    // miss by REFUSING, so a missing passport arrives as a thrown error with the
    // payload the command kernel classifies; nothing here turns one into an
    // empty answer, because an empty answer would paint as "no evidence" rather
    // than "unknown".
    async engineeringPassport(args = {}, { signal } = {}) { return rpc('engineering-passport', args, signal); },
    async readPortfolio(args = {}) { return rpc('read-portfolio', args); },
    async workRequestCard(args = {}, { signal } = {}) { return rpc('work-request-card', args, signal); },
    async declineWorkRequest(args) { return write('decline-work-request', args); },
    async supersedeWorkRequest(args) { return write('supersede-work-request', args); },
    async setWorkShapeDisposition(args) { return write('set-work-shape-disposition', args); },

    // ------------------------------------------------------ Control Room (C01)
    // Three read-only verbs, passed through untouched. Two of them take NO
    // arguments at all and refuse any field, so nothing is defaulted in here:
    // a tenant, an owner or a filter invented by the browser is exactly what
    // those verbs exist to refuse.
    async incidentBoard(args = {}, { signal } = {}) { return rpc('incident-board', args, signal); },
    async currentWorkItem({ signal } = {}) { return rpc('current-work-item', {}, signal); },
    async readResourceDashboard({ signal } = {}) { return rpc('read-resource-dashboard', {}, signal); },
    async currentWorkRequests({ signal } = {}) {
      const res = await fetchReadImpl('/api/system-work/current', {
        credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store',
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const error = new Error(`live current work requests -> HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      const envelope = await res.json();
      if (envelope?.ok !== true || !envelope.data) throw new Error('live current work requests -> invalid response');
      const data = envelope.data;
      // Bind optional advice to the exact canonical array this client will render.
      // A forged or stale digest is displayed as unavailable, never as a score.
      let advisoryBindingVerified = false;
      if (Array.isArray(data.items) && data.advisory?.snapshot_digest && globalThis.crypto?.subtle) {
        try {
          const bytes = new TextEncoder().encode(JSON.stringify(data.items));
          const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
          const digest = `sha256:${[...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
          advisoryBindingVerified = digest === data.advisory.snapshot_digest;
        } catch { /* Advisory validation may fail; the canonical queue still reads. */ }
      }
      return { ...data, advisory_binding_verified: advisoryBindingVerified };
    },

    // ------------------------------------------------- Operations cards (C14)
    // One read-only verb, passed through untouched. It takes NO arguments and
    // refuses any field, so none is sent. It grants no authority: the decisions
    // it lists are taken with their own partner verbs. Adoption uses the session write path.
    async readConnections({ signal } = {}) { return (await rpc('read-resource-dashboard', {}, signal)).connections; },
    async adoptRule(args) { return write('adopt-rule', args); },
    async governanceQueue() { return rpc('governance-queue', {}); },
    async scheduleBoard({ signal } = {}) { return rpc('schedule-board', {}, signal); },

    // ---------------------------------------------------- incident page (C14)
    // One read and one write, passed through untouched. The write's arguments
    // are exactly what the verb declares (it refuses any other field, and it
    // takes no base version), so nothing is added here.
    async getIncident(args = {}) { return rpc('get-incident', args); },
    async linkIncidentWorkRequest(args) { return write('link-incident-work-request', args); },

    // ------------------------------------------------ notifications page (B12a)
    // One read and one write, passed through untouched. NEITHER takes a
    // recipient: `ops.notification_feed_facts` resolves the caller itself, and
    // a recipient argument is exactly what those verbs exist to refuse. The
    // feed goes through `rpc` because it carries no idempotency key; the
    // acknowledgement goes through `write` because it does.
    async notificationFeed(args = {}) { return rpc('notification-feed', args); },
    async acknowledgeNotification(args) { return write('acknowledge-notification', args); },

    // ------------------------------- notification preferences (B12, WR-000116)
    // One read and one write, passed through untouched. The read declares ZERO
    // properties under additionalProperties:false — that is the whole defence
    // that no caller argument names an actor, so nothing is passed to it at
    // all, not even an empty option bag that a later edit could fill. The write
    // goes through `write` because it carries an idempotency key, and its
    // `base_version` is a compare-and-swap the caller must have READ: this
    // layer never supplies, defaults or increments it.
    async notificationPreferences() { return rpc('read-notification-preferences', {}); },

    // --------------------------------- session identity and dispatch (S02)
    // Three reads, passed through untouched. None names an actor: their schemas
    // declare additionalProperties:false with no actor property at all, and the
    // acting actor is resolved server-side from a transaction-local setting the
    // browser cannot reach. That absence is what makes the permission filtering
    // these reads report unforgeable rather than merely unrequested. They go
    // through `rpc` because they carry no idempotency key, and there is no
    // matching write. Open is local navigation for a checkpoint-proved native
    // target; no verb resumes, messages, or takes over a session.
    async sessionIdentity(args = {}, { signal } = {}) { return rpc('read-session-identity', args, signal); },
    async codexSessions(_args = {}, { signal } = {}) { return rpc('list-my-codex-sessions', {}, signal); },
    async dispatchHistory(args, { signal } = {}) { return rpc('read-dispatch-history', args, signal); },

    // ------------------------------- Model Room assignments and turns (C12)
    // These reads derive the actor server-side. Assignment moves and dispatch
    // acknowledgements have no supported write from this page.
    async roomQueue(args = {}) { return rpc('read-room-queue', args); },
    async roomTurns(args = {}) { return rpc('read-room', args); },
    // V5-UX-C13b: the Model Room composer's one write. `add-room-turn`
    // derives origin_channel/origin_actor server-side from this session and
    // only requires the caller's own personal scope (mcp-server/src/
    // identity.js personalScopeForActor) — true for Joe's or Dell's own
    // authenticated browser session — so a human caller here is honest, not
    // borrowed. It carries an idempotency key, so it goes through `write`.
    async addRoomTurn(args) { return write('add-room-turn', args); },
    // V5-UX-C13c: the Waiting-for-Joe answer form's one write. `answer-work-
    // request-for-joe` (carr PR #1190) carries an idempotency key, so it goes
    // through `write`, exactly like `addRoomTurn`. HUMAN-ONLY at the server
    // (actor.human !== true is refused there, with no sponsored-agent route
    // at all); this client passes no actor field of its own.
    async answerWorkRequestForJoe(args) { return write('answer-work-request-for-joe', args); },
    async unfinishedWork(args = {}, { signal } = {}) { return rpc('unfinished-work', args, signal); },
    async triageSystemWork(verb, args) {
      const allowed = new Set(['close-loop','update-loop','decline-work-request','review-and-triage',
        'cancel-capability-session','triage-incident','cancel-workflow-cutover-plan',
        'advance-workflow-cutover-stage','confirm-slice-completions','close-investigation',
        'accept-ready-plan-amendment','approve-retrieval-proposals']);
      if (!allowed.has(verb)) throw new Error('Unsupported system work action.');
      return write(verb, args);
    },
    async listProgressBoards(_args = {}, { signal } = {}) { return rpc('list-progress-boards', {}, signal); },
    async readProgressBoard(args, { signal } = {}) { return expandBoardRead(await rpc('read-progress-board', args, signal)); },
    async workQueue(_args = {}, { signal } = {}) { return rpc('work-queue', {}, signal); },
    async answerBoardQuestion(args) { return write('answer-board-question', args); },
    async setNotificationPreference(args) { return write('set-notification-preference', args); },

    // -------------------------------------------- Doc conversations page (B07)
    // One read and three writes, passed through untouched. NONE of them names an
    // actor: the creator, the grantor and every timestamp are derived inside the
    // definer functions, and additionalProperties:false turns an attempt to name
    // one into a schema error. The read goes through `rpc` because it carries no
    // idempotency key; the three writes go through `write` because they do. Note
    // that create's key BECOMES the conversation id, so a second key is a second
    // conversation — the kernel's retained request is what keeps that honest.
    async readDocConversation(args = {}, { signal } = {}) { return rpc('read-doc-conversation', args, signal); },
    async listDocConversations(args = {}, { signal } = {}) { return rpc('list-doc-conversations', args, signal); },
    async listDocSuggestions(args = {}, { signal } = {}) { return rpc('list-doc-suggestions', args, signal); },
    async decideDocSuggestion(args) { return write('decide-doc-suggestion', args); },
    async proposeDocCorrection(args) { return write('propose-doc-correction', args); },
    async createDocConversation(args) { return write('create-doc-conversation', args); },
    async renameDocConversation(args) { return write('rename-doc-conversation', args); },
    async shareDocConversation(args) { return write('share-doc-conversation', args); },

    // -------------------------------------------------- Doc outcome cards (B09)
    // ONE READ, passed through untouched. It names no actor: the producer
    // (mcp-server/src/tools.js docOutcomeCardsProjection, wrapping
    // ops.read_doc_outcome_cards_successor from migration 0546) derives the
    // acting actor and tenant server-side, and the verb's schema declares only
    // `cursor`/`limit` under additionalProperties:false. It goes through `rpc`
    // because it carries no idempotency key, and there is no matching write:
    // this is a bounded projection that creates no writer, dispatcher, retry,
    // task or native-session authority, and it never launches anything.
    async docOutcomeCards(args = {}, { signal } = {}) { return rpc('read-doc-outcome-cards', args, signal); },

    // ------------------------------------------------ global search (B05)
    // Two READS, passed through untouched. NEITHER names an actor, a tenant or
    // a kind: `find` declares one property and `find-and-catch-up` two, both
    // under additionalProperties:false, so a third argument is refused by the
    // gateway with `unregistered_operation_fields` before the handler runs.
    // They go through `rpc` because they carry no idempotency key.
    async find(args = {}, { signal } = {}) { return rpc('find', args, signal); },
    async findAndCatchUp(args = {}, { signal } = {}) { return rpc('find-and-catch-up', args, signal); },

    setProspectEngagementStatus: createEngagementWriter(args => write('set-prospect-engagement-status', args, opts.writeTimeoutMs || 10_000)),
    async startReview(args) { return write('start-deal-review', args); },
    async reviewDeal(args) { return write('review-deal', args); },
    async endReview(args) { return write('end-deal-review', args); },
    async setMarketAgent(args) { return write('set-market-agent', args); },
    async setNationalAccountOwner(args) { return write('set-national-account-owner', args); },
    async createNationalAccount(args) { return write('create-national-account', args); },
    async createNationalMarketDeal(args) { return write('create-national-market-deal', args); },
    async revertDealField(args) { return write('revert-deal-field', args); },
    async readDocActivity(args = {}, { signal } = {}) { return rpc('read-doc-activity', args, signal); },
  };
  return opts.docContext === false ? client : observeDocClient(client);
}
