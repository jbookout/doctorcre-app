import { validEmailDraftReceipt, validEmailDraftSaveReceipt } from './email-draft.js';
import { sessionFetch } from './private-session.js';
import { PHASE_BY_SLUG, TYPE_TO_UI } from './client.js';
import { requireReviewReceipt } from './deal-review-model.js';
import { isEngineDealDetail } from './local-deals-model.js';
/**
 * Live client: same interface as fixture, against the deployed Worker.
 * Verbs travel as MCP JSON-RPC tools/call over the cookie-authenticated /mcp
 * mount; the event cursor is plain GET /pipeline/changes. Both are same-origin
 * on each reviewed Deal Room host, so no baseUrl is needed in production or
 * staging; one may be passed directly for isolated client tests.
 */
import { uuidv4 } from './uuid.js';
import { fetchRead, readWithDeadline } from './current-read.mjs';
import { createMcpRequests, unknownMcpOutcome } from './mcp-requests.mjs';
import { observeDocClient } from './doc-context.js';
import { createEngagementWriter } from './prospect-engagement.mjs';
import { requireEmailActionReceipt } from './email-action-receipt.mjs';
import { classifyCommandOutcome } from './command-feedback.mjs';
import { createRetainedCommands } from './retained-commands.mjs';
import { parseChangesPage, parseEnginePreference, parseMarkedUpdates, parseUpdates } from './notifications-model.js';

// Verified pre-commit refusals from new-deal and its argument/subject checks
// in CARR producer 0cc6fe2538a81521bf8c25b0df58aa4063ed614b. Internal and
// unrecognized errors can follow a committed write; retain those for replay.
const CREATION_REFUSALS = new Set([
  'missing_required', 'subject_not_found', 'needs_disambiguation', 'not_a_client',
  'deal_name_exists', 'deal_save_unavailable', 'salesforce_id_in_use', 'unknown_deal_type',
  'unknown_phase', 'unknown_lane', 'reload_deals',
]);
const NEXT_CREATION_REFUSALS = new Set([
  'database_refused_the_statement', 'invalid_field_value', 'unknown_owner', 'version_conflict', 'not_a_prospect',
]);

export { dealTypeLabel } from './client.js';

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
let browserCallDecisions;
const SHARED_READ_VERBS = new Set(['deal-room-board', 'morning-brief']);

export function createLiveClient(opts = {}) {
  const baseUrl = (opts.baseUrl || '').replace(/\/$/, '');
  let selfActor = opts.selfActor || null;
  const fetchImpl = opts.fetchImpl || ((path, init) => sessionFetch(`${baseUrl}${path}`, init));
  const online = opts.online || (() => globalThis.navigator?.onLine !== false);
  const page = globalThis.document?.documentElement;
  let changeFeedRetired = false;
  const disableChangeFeed = () => {
    changeFeedRetired = true;
    page?.setAttribute('data-deals-from-engine', '');
  };
  const requestMcp = createMcpRequests({ fetchImpl, typedContent: false });
  const dealCreations = new Map();
  const fetchReadImpl = (path, init) => fetchRead(path, init, { fetchImpl, timeoutMs: opts.readTimeoutMs || 10_000 });
  const commands = createRetainedCommands({ scope: () => selfActor });
  const commandSession = async () => {
    const response = await fetchReadImpl('/auth/session', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) throw Object.assign(new Error('Sign in again before checking this write.'), { status: response.status });
    const session = await response.json();
    if (typeof session?.actor?.slug !== 'string' || typeof session.csrf_token !== 'string' || !session.csrf_token)
      throw new Error('The current session could not be verified. No write was sent.');
    if (selfActor && selfActor !== session.actor.slug) throw Object.assign(new Error('Session changed. Reopen the record before writing.'), { code: 'session_changed' });
    return `${session.actor.slug}:${session.csrf_token}`;
  };
  const sessionCommands = createRetainedCommands({ scope: commandSession });
  const sessionWrites = new Set(['link-parties', 'set-next-step', 'set-market-agent', 'set-national-account-owner', 'create-national-account',
    'create-national-market-deal', 'start-deal-review', 'review-deal', 'end-deal-review',
    'resolve-candidate', 'resolve-post-call-candidate',
    'undo-call-change', 'review-call-outcome', 'review-deal-update', 'confirm-email-filing', 'confirm-email-next-step', 'confirm-email-deal-progress', 'dismiss-email-proposal', 'snooze-email-proposal', 'handle-email-proposal', 'edit-email-draft', 'submit-email-draft', 'register-client-portal', 'decide-engine-deal-email']);

  const readTimeoutMs = opts.readTimeoutMs || 10_000;
  const rpc = (verb, args = {}, signal, headers) => {
    if (!SHARED_READ_VERBS.has(verb)) return rawRpc(verb, args, signal, readTimeoutMs, headers);
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

  // Engine answers keep their status and body so the page can read the refusal's code.
  const engineAnswer = async response => {
    const body = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(`engine ${response.status}`), { status: response.status, payload: body });
    return body;
  };
  const engineRead = async path => engineAnswer(await fetchReadImpl(path, { headers: { accept: 'application/json' } }));
  const engineSave = (path, body, csrf) => readWithDeadline(async signal => engineAnswer(await fetchImpl(path, {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json', ...(csrf && { 'x-carr-csrf': csrf }) }, body: JSON.stringify(body),
  })), { timeoutMs: opts.writeTimeoutMs || 10_000 });

  async function rawRpc(verb, args = {}, signal, timeoutMs, headers) {
    const outcome = await requestMcp(verb, args, { signal, timeoutMs, headers });
    if (outcome.kind === 'authorization' || outcome.reason === 'http') {
      const error = new Error(`live ${verb} -> HTTP ${outcome.status}`);
      error.status = outcome.status;
      if (outcome.kind !== 'authorization') error.body = outcome.body;
      throw error;
    }
    if (outcome.kind === 'unconfirmed') {
      if (outcome.reason === 'rpc') throw Object.assign(new Error(`live ${verb} rpc error: ${outcome.cause.message}`), { rpcCode: outcome.cause.code });
      if (['network', 'deadline', 'envelope', 'payload'].includes(outcome.reason)) throw outcome.cause;
      throw unknownMcpOutcome(outcome.cause);
    }
    const { payload, isError } = outcome;
    if (isError || (payload?.error && payload.ok !== true)) {
      const err = new Error(`live ${verb} refused: ${payload?.error || 'tool_error'}`);
      err.payload = payload;
      if (verb === 'new-deal') err.creationStage = 'new-deal';
      err.writeRefusal = verb === 'new-deal' && (CREATION_REFUSALS.has(payload?.error)
        || (args.next_deal_save === true && NEXT_CREATION_REFUSALS.has(payload?.error)))
        || (['resolve-candidate', 'resolve-post-call-candidate'].includes(verb)
          && ['refused', 'conflict'].includes(classifyCommandOutcome({ error: err }).status));
      throw err;
    }
    if (verb === 'start-deal-review') requireReviewReceipt(payload);
    if (['confirm-email-next-step', 'confirm-email-deal-progress'].includes(verb)) {
      const contract = verb === 'confirm-email-next-step' ? 'email-next-step.v1' : 'email-deal-progress.v1';
      if (payload?.contract !== contract || payload.status !== 'confirmed' || payload.requires_confirmation !== false
        || payload.deal !== args.deal || payload.source?.activity_id !== args.activity_id || payload.proposal_digest !== args.proposal_digest)
        throw unknownMcpOutcome(new Error('Email confirmation receipt unavailable'));
      return { ...payload, ok: true };
    }
    if (verb === 'edit-email-draft' && !validEmailDraftSaveReceipt(payload, args))
      throw unknownMcpOutcome(new Error('Draft save receipt unavailable'));
    if (verb === 'submit-email-draft' && !validEmailDraftReceipt(payload, args))
      throw unknownMcpOutcome(new Error('Reply submission receipt unavailable'));
    return payload;
  }

  function requireActive(signal) {
    if (signal?.aborted) throw Object.assign(new Error('Write cancelled before dispatch'), { code: 'not_sent' });
  }

  async function write(verb, args, timeoutMs, signal) {
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
    const target = ['assessment_id', 'proposal_id', 'activity_id', 'deal', 'candidate_id', 'account_client_id', 'event_id', 'human_ref', 'session_id',
      'section_id', 'entity_ref', 'fact_key', 'loop_id', 'conversation_id', 'suggestion_id', 'commission_id', 'board_id', 'client_id', 'field', 'projection_id']
      .filter(key => args[key] !== undefined).map(key => [key, args[key]]);
    const operationKey = JSON.stringify([verb, target]);
    const retained = sessionWrites.has(verb) ? sessionCommands : commands;
    return retained.send(operationKey, args, (request, binding) => {
      requireActive(signal);
      return rawRpc(verb, request, signal, timeoutMs || opts.writeTimeoutMs || 10_000,
        sessionWrites.has(verb) ? { 'x-carr-csrf': binding.slice(binding.indexOf(':') + 1) } : undefined);
    });
  }

  function replaceMarketAgent(args) {
    let removals, added;
    return sessionCommands.send(JSON.stringify(['replace-market-agent', args.deal]), args, async (request, binding) => {
      if (!online()) throw Object.assign(new Error('Offline. Reconnect before saving.'), { payload: { error: 'offline' } });
      const { deal, agent_party_id, seen_change_id } = request;
      const headers = { 'x-carr-csrf': binding.slice(binding.indexOf(':') + 1) };
      const save = async (verb, body, party) => {
        const receipt = await rawRpc(verb, body, undefined, opts.writeTimeoutMs || 10_000, headers);
        if (receipt?.ok !== true || receipt.deal_id !== deal || receipt.party_id !== party || receipt.role !== 'market_agent')
          throw unknownMcpOutcome(new Error('Market agent receipt unavailable'));
        return receipt;
      };
      if (!removals) {
        const detail = await rpc('get-deal-room', { deal }).catch(() => null);
        if (detail?.deal_id !== deal || !Number.isSafeInteger(detail.seen) || !Array.isArray(detail.participants))
          throw Object.assign(new Error('Could not read the current market agents. Reload the deal and try again.'), { code: 'not_sent' });
        removals = new Map();
        for (const { party_id, role } of detail.participants) {
          if (role !== 'market_agent') continue;
          if (party_id === agent_party_id) added = { ok: true, deal_id: deal, party_id, role };
          else if (!removals.has(party_id))
            removals.set(party_id, { deal, party_id, role, seen_change_id, idempotency_key: uuidv4() });
        }
      }
      added ??= await save('set-market-agent', request, agent_party_id);
      // eslint-disable-next-line no-restricted-syntax -- Send a removal once per distinct prior agent in the retained snapshot for each click.
      for (const [party, removal] of removals) {
        await save('remove-deal-participant', removal, party);
        removals.delete(party);
      }
      return added;
    }, 'replace-market-agent');
  }

  function emailAction(method, verb, args, context) {
    const activityId = context?.activityId;
    return sessionCommands.send(JSON.stringify(['email-action', args.proposal_id]), args, async (request, binding) => {
      if (!online()) throw Object.assign(new Error('Offline. Reconnect before checking outcome.'), { payload: { error: 'offline' } });
      const receipt = await rawRpc(verb, request, undefined, opts.writeTimeoutMs || 10_000, { 'x-carr-csrf': binding.slice(binding.indexOf(':') + 1) });
      requireEmailActionReceipt(method, request, receipt, activityId);
      return receipt;
    }, method);
  }

  // CARR phase slugs and board labels map one-to-one in both directions.
  const PHASE_TO_UI = { ...PHASE_BY_SLUG, dead: 'Lost' };
  const UI_TO_PHASE = {
    'On Deck': 'pending', 'Research': 'research', 'Site selection': 'site_selection',
    'Negotiation': 'negotiation', 'Legal': 'legal', 'Diligence': 'due_diligence',
    'Closing': 'closing', 'Closed': 'closed',
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
    type: TYPE_TO_UI.get(d.type)?.[1] ?? d.type,
    next_step: d.next_step || '',
    market: d.market ?? d.city ?? '',
    version: d.version ?? d.base_version,
  });

  const client = {
    mode: /** @type {const} */ ('live'),
    get changeFeedEnabled() { return !changeFeedRetired && !page?.hasAttribute('data-deals-from-engine'); },
    get selfActor() { return selfActor; },
    async readAssuranceHealth(args) { const { assuranceHealthRequest } = await import('./assurance-health-model.js'); return rpc('read-assurance-health', assuranceHealthRequest(args)); },
    async linkParties(args) { return write('link-parties', args); },
    async getRelationshipNetwork({ signal, step } = {}) {
      const query = new URLSearchParams({ contract: 'relationship-network.v1' });
      if (step) query.set('step', step);
      const read = () => fetchReadImpl(`/api/v1/business/relationships?${query}`, {signal,credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'}});
      let response = await read();
      if (step && response.status === 400 && (await response.json().catch(() => null))?.error === 'QUERY_INVALID') {
        query.delete('step');
        response = await read();
      }
      if (!response.ok) throw Object.assign(new Error('Relationships unavailable'), {status:response.status});
      return response.json();
    },

    // Each deal carries `field_base` — the latest committed event id and time for
    // every editable cell, read in the same statement as the values it belongs
    // to. It passes through untouched: it is the record layer's own identity for
    // an event, in the record layer's own field vocabulary, and translating or
    // rebuilding it would be inventing one.
    async getInvoiceTracker({ signal } = {}) { return rpc('read-invoice-tracker', {}, signal); },
    async markInvoicePaid(args) { return write('record-commission-receipt', args, opts.writeTimeoutMs || 10_000); },
    async undoAutomaticPhaseMove(args) { return write('undo-automatic-phase-move', args); },
    async undoInvoiceClose(args) { return write('undo-invoice-close', args); },
    async listPracticeOrigination({signal, ...args} = {}) { return rpc('list-practice-origination', args, signal); },
    async getHomeAgenda({ signal } = {}) {
      const agenda = await rpc('read-home-agenda', {}, signal);
      selfActor = agenda.actor || selfActor;
      return { ...agenda, deals: Array.isArray(agenda.deals) ? agenda.deals.map(dealToUi) : agenda.deals };
    },
    async getPostCallFollowups({ signal } = {}) { return rpc('read-post-call-followups', {}, signal); },

    async savePartnerRecord(path, key, receipt, args) {
      try {
        return await sessionCommands.send(key, args ?? sessionCommands.pending(key), async (body, binding) => {
          const response = await fetchReadImpl(path, { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-carr-csrf': binding.slice(binding.indexOf(':') + 1) },
            body: JSON.stringify(body) });
          const data = await response.json();
          if (!response.ok) throw Object.assign(Error('Save refused'), { status: response.status, payload: data });
          if (typeof data?.[receipt] !== 'string') throw Error('Save receipt unavailable');
          return { ok: true, data, sent: body };
        });
      } catch (error) {
        return { ok: false, problem: error.payload ?? { error: error.code }, pending: Boolean(error.pendingRequest) };
      }
    },

    async getCalendarItems() {
      const response = await fetchReadImpl('/api/engine/calendar/critical-dates');
      if (!response.ok) throw Object.assign(new Error('Calendar dates could not be read.'), { status: response.status });
      const data = await response.json();
      if (data?.schema_version !== 'calendar-critical-dates.v1' || !Array.isArray(data.critical_dates) ||
          (data.next_steps !== undefined && !Array.isArray(data.next_steps)))
        throw new Error('Calendar dates could not be read.');
      return data;
    },

    async getCalendarMeetings({ from, to }) {
      const response = await fetchReadImpl(`/api/engine/calendar/meetings?${new URLSearchParams({ from, to })}`);
      if (!response.ok) throw Object.assign(new Error('Meetings could not be read.'), { status: response.status });
      const data = await response.json();
      if (data?.schema_version !== 'calendar-meetings.v1' || !Array.isArray(data.meetings)) throw new Error('Meetings could not be read.');
      return data;
    },

    async getBoard(options = {}) {
      const board = await rpc('deal-room-board', {
        workspace: options.workspace || 'all',
        ...(options.account_client_id ? { account_client_id: options.account_client_id } : {}),
      }, options.signal);
      if (board.board_from_engine === true) disableChangeFeed();
      selfActor = board.actor || selfActor;
      return { ...board, deals: Array.isArray(board.deals) ? board.deals.map(dealToUi) : board.deals,
        lost_deals: Array.isArray(board.lost_deals) ? board.lost_deals.map(dealToUi) : undefined,
        closed_deals: Array.isArray(board.closed_deals) ? board.closed_deals.map(dealToUi) : undefined };
    },

    async readDealDocumentText(args = {}, { signal } = {}) { return rpc('read-deal-document-text', args, signal); },

    async listDealDocuments(args = {}, { signal } = {}) { return rpc('list-deal-documents', args, signal); },

    async getDeal(dealId, { signal } = {}) {
      const page = await rpc('get-deal-room', { deal: dealId }, signal);
      const { thread = [], critical_dates = [], events = [], imported_deal_history, correspondence, email_threads, properties, workflow_suggestions, deal_id, ...fields } = page;
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
        participants: page.participants || [],
        premises: page.premises || [],
        negotiation_rounds: page.negotiation_rounds || [],
        documents: page.documents || [],
        ...(isEngineDealDetail(page) ? {
          email_follow_ups: page.email_follow_ups, next_deal_saves: page.next_deal_saves === true,
          imported_deal_history, correspondence, properties, workflow_suggestions, invoice: page.invoice ?? null,
        } : Object.hasOwn(page, 'email_threads') ? { email_threads } : {}),
        lease: page.lease ?? null,
        checklist: page.checklist ?? null,
        plan: page.plan ?? null,
        record_links: page.record_links ?? [],
        schema_version: page.schema_version,
      };
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

    async readDealUpdateReviews(args = {}) { return rpc('read-deal-update-reviews', args); },
    async reviewDealUpdate(args) { return write('review-deal-update', args); },
    async listEmailProposals(args = {}, signal) { return rpc('list-email-proposals', args, signal); },
    async decideDealEmail({ proposal_id, decision, idempotency_key, edits }) {
      return write('decide-engine-deal-email', { proposal_id, decision, idempotency_key, ...(edits && { edits }) });
    },
    async previewEmailNextStep(args) { return rpc('preview-email-next-step', args); },
    async previewEmailDealProgress(args) { return rpc('preview-email-deal-progress', args); },
    async previewEmailFiling(args) { return rpc('preview-email-filing', args); },
    getPendingEmailAction(proposalId) {
      return sessionCommands.details(JSON.stringify(['email-action', proposalId]));
    },
    async snoozeEmailProposal(args) { return emailAction('snoozeEmailProposal', 'snooze-email-proposal', args); },
    async handleEmailProposal(args) { return emailAction('handleEmailProposal', 'handle-email-proposal', args); },
    async confirmEmailFiling(args, context) { return emailAction('confirmEmailFiling', 'confirm-email-filing', args, context); },
    async confirmEmailNextStep(args) { return write('confirm-email-next-step', args); },
    async confirmEmailDealProgress(args) { return write('confirm-email-deal-progress', args); },
    async editEmailDraft(args) { return write('edit-email-draft', args); },
    async submitEmailDraft(args) { return write('submit-email-draft', args); },
    async dismissEmailProposal(args) { return write('dismiss-email-proposal', args); },

    async readDealCallOutcomes(dealId) {
      return engineRead(`/api/engine/deals/${encodeURIComponent(dealId)}/call-outcomes`);
    },

    async decideCallProposal({ proposal_id, decision }) {
      const retained = page && !opts.fetchImpl
        ? (browserCallDecisions ??= createRetainedCommands({ scope: commandSession }))
        : sessionCommands;
      const key = JSON.stringify(['call-decision', proposal_id]);
      const args = decision ? { decision } : retained.pending(key);
      if (!args) return;
      return retained.send(key, args, async (request, binding) => {
        const receipt = await engineSave(`/api/engine/proposals/${encodeURIComponent(proposal_id)}/decision`,
          request, binding.slice(binding.indexOf(':') + 1));
        if (receipt?.proposal_id !== proposal_id || receipt.status !== (request.decision === 'accept' ? 'accepted' : 'dismissed'))
          throw new Error('Call decision receipt unavailable');
        return { ok: true };
      });
    },

    async readCallOutcomes() {
      return rpc('read-call-outcomes', {});
    },

    async undoCallChange({ candidate_id, base_version }) {
      return write('undo-call-change', { candidate_id, base_version });
    },

    async reviewCallOutcome({ session_id, expected_source_version }) {
      return write('review-call-outcome', { session_id, expected_source_version });
    },

    async getChanges(cursor, { signal, since } = {}) {
      if (!client.changeFeedEnabled) return null;
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
        if (res.status === 204) {
          disableChangeFeed();
          return null;
        }
        // Refusal is decided by the headers. Its diagnostic body must not
        // turn a known authorization failure into a statusless read failure.
        if (!res.ok) throw Object.assign(new Error(`live changes -> ${res.status}`), { status: res.status });
        return res.json();
      }, { signal, timeoutMs:opts.readTimeoutMs || 10_000 });
      if (!client.changeFeedEnabled) return null;
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

    async patchDealField(args) {
      if (args.field === 'phase' && UI_TO_PHASE[args.value]) {
        args = { ...args, value: UI_TO_PHASE[args.value] };
      }
      // `change_reason` rides through untouched: the partner's
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

    // Keep the version the partner reviewed so a crossed edit cannot silently overwrite it.
    async updateDeal(args) {
      return write('update-deal', args);
    },

    async recordDealItem(args) { return write('record-deal-item', { ...args, source_ref: args.source_ref || `app:deal-item:${args.idempotency_key}` }); },
    async instructDealItem(args) { return write('instruct-deal-item', args); },
    async completeOneAction(args) { return write('complete-one-action', args, opts.writeTimeoutMs || 10_000); },
    async completeDealStep({ next_step_id, base_version, idempotency_key }) {
      if (!online()) throw Object.assign(new Error('Offline. Reconnect before saving.'), { payload: { error: 'offline' } });
      return readWithDeadline(async signal => {
        const response = await fetchImpl(`/api/engine/next-steps/${encodeURIComponent(next_step_id)}/end`, {
          method: 'POST', credentials: 'same-origin', signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resolution: 'done', base_version, idempotency_key }),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw Object.assign(new Error('Step completion refused'), { status: response.status, payload: body });
        if (body?.error || body?.next_step_id !== next_step_id || body.status !== 'done'
            || !Number.isSafeInteger(body.change_id) || body.change_id <= base_version)
          throw new Error('Step completion receipt unavailable');
        return { ...body, ok: true };
      }, { timeoutMs: opts.writeTimeoutMs || 10_000 });
    },
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
    async confirmCriticalDate(args) { return write('confirm-critical-date', args); },
    async resolveCriticalDate(args) { return write('resolve-critical-date', args); },

    async createDeal(args) {
      const key = args.idempotency_key || uuidv4();
      const phase = UI_TO_PHASE[args.phase] || args.phase || 'pending';
      const owner = args.owner || selfActor;
      const legacyKind = ['purchase', 'other'].includes(args.deal_type) ? args.deal_type : undefined;
      const request = args.next_deal_save || args.prospect_id !== undefined ? {
        next_deal_save: true, idempotency_key: key, name: args.name, phase, owner,
        client_id: args.client_id, prospect_id: args.prospect_id,
        kind: args.kind ?? legacyKind,
        reason: args.reason ?? (legacyKind ? undefined : args.deal_type === 'startup' ? 'start_up' : args.deal_type || undefined),
        market_id: args.market_id, renews_lease_id: args.renews_lease_id,
      } : {
        client: args.client,
        name: args.name,
        deal_type: args.deal_type || 'other',
        phase,
        segment: args.segment || undefined,
        city: args.market || undefined,
        lane: args.lane || 'territory',
        reason: 'Created in the Deal Room',
        idempotency_key: key,
      };
      const intent = { ...request, client: args.client, owner, notes: args.notes || '' };
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
          try {
            res = await write('new-deal', operation.request);
          } catch (error) {
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
        if (!request.next_deal_save && !operation.lead) {
          const fresh = await rpc('get-deal-room', { deal: res.deal_id });
          if (!Number.isInteger(fresh?.base_version)) throw new Error('Created deal version is unavailable; lead was not assigned.');
          operation.lead = { deal: res.deal_id, new_lead: operation.actor, base_version: fresh.base_version, idempotency_key: uuidv4() };
        }
        if (!request.next_deal_save && !operation.leadConfirmed) {
          const lead = await write('set-lead', operation.lead);
          if (lead?.ok !== true) throw new Error('Lead receipt is unavailable. Reconcile the same request.');
          operation.leadConfirmed = true;
        }
        if (intent.notes && !operation.noteConfirmed) {
          operation.note ||= { deal: res.deal_id, text: intent.notes, idempotency_key: uuidv4(),
            ...(request.next_deal_save && { seen_change_id: res.change_id, happened_at: new Date().toISOString() }) };
          const note = await write('add-deal-note', operation.note);
          if (note?.ok !== true) throw new Error('Note receipt is unavailable. Reconcile the same request.');
          operation.noteConfirmed = true;
        }
        operation.result = { status: 'ok', deal_id: res.deal_id };
        return operation.result;
      })();
      try { return await operation.inFlight; } finally { operation.inFlight = null; }
    },

    async morningBrief({ signal, fresh } = {}) { return fresh ? rawRpc('morning-brief', {}, signal, readTimeoutMs) : rpc('morning-brief', {}, signal); },

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

    // The Updates page's engine routes, used once deal saves go to the engine (#1175).
    async updates() { return parseUpdates(await engineRead('/api/engine/updates')); },
    async markUpdatesRead(args) {
      return parseMarkedUpdates(await engineSave('/api/engine/updates/read', args), args.update_ids);
    },
    async preferences() { return parseEnginePreference(await engineRead('/api/engine/preferences')); },
    async savePreferences(args) {
      const answer = await engineSave('/api/engine/preferences', args);
      if (answer?.ok !== true) throw new Error('Invalid preferences receipt');
      return { ok: true, replayed: answer.replayed === true, preference: parseEnginePreference(answer) };
    },
    async updateChanges(before = null) {
      return parseChangesPage(await engineRead(`/api/engine/updates/changes${before ? `?before=${encodeURIComponent(before)}` : ''}`));
    },

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
    async askSession() {
      const response = await fetchReadImpl('/auth/session', { credentials:'same-origin', cache:'no-store' });
      const session = await response.json();
      if (!response.ok || !session?.actor?.slug) throw Error('Sign in to continue.');
      return { actor:session.actor.slug };
    },
    async createDocConversation(args) { return write('create-doc-conversation', args); },
    async renameDocConversation(args) { return write('rename-doc-conversation', args); },
    async shareDocConversation(args) { return write('share-doc-conversation', args); },

    // ------------------------------------------------ global search (B05)
    // Two READS, passed through untouched. NEITHER names an actor, a tenant or
    // a kind: `find` declares one property and `find-and-catch-up` two, both
    // under additionalProperties:false, so a third argument is refused by the
    // gateway with `unregistered_operation_fields` before the handler runs.
    // They go through `rpc` because they carry no idempotency key.
    async find(args = {}, { signal, searchRecords = false } = {}) {
      return rpc('find', args, signal, searchRecords ? { 'x-doctorcre-search': 'search.v1' } : undefined);
    },
    async findAndCatchUp(args = {}, { signal } = {}) { return rpc('find-and-catch-up', args, signal); },

    setProspectEngagementStatus: createEngagementWriter(args => write('set-prospect-engagement-status', args, opts.writeTimeoutMs || 10_000)),
    async startReview(args) { return write('start-deal-review', args); },
    async reviewDeal(args) { return write('review-deal', args); },
    async endReview(args) { return write('end-deal-review', args); },
    async setMarketAgent(args) {
      return args.agent_party_id ? replaceMarketAgent(args) : write('set-market-agent', args);
    },
    async searchPeople(query, signal) {
      const result = await rpc('search-parties-v1', { query }, signal);
      if (result?.schema_version !== 'party-search.v1' || !Array.isArray(result.parties))
        throw new Error('People could not be loaded.');
      return result.parties.filter(row => row?.kind === 'person').map(row => [row.id, row.display_name]);
    },
    async setNationalAccountOwner(args) { return write('set-national-account-owner', args); },
    async createNationalAccount(args) { return write('create-national-account', args); },
    async getMarketDealChoices(accountId) {
      const read = async path => {
        const response = await fetchReadImpl(`/api/engine/${path}`);
        if (!response.ok) throw new Error('Market deal choices could not be loaded.');
        return response.json();
      };
      const [marketList, locationList] = await Promise.all([
        read('markets'), read(`national-accounts/${encodeURIComponent(accountId)}/locations`),
      ]);
      return {
        markets: marketList.map(({ market_id, name }) => [market_id, name]),
        locations: locationList.map(({ party_id, name }) => [party_id, name]),
      };
    },
    async createNationalMarketDeal(args) { return write('create-national-market-deal', args); },
    async revertDealField(args) { return write('revert-deal-field', args); },
  };
  return opts.docContext === false ? client : observeDocClient(client);
}
