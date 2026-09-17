/**
 * Live client: same interface as fixture, against the deployed Worker.
 * Verbs travel as MCP JSON-RPC tools/call over the cookie-authenticated /mcp
 * mount; the event cursor is plain GET /pipeline/changes. Both are same-origin
 * on each reviewed Deal Room host, so no baseUrl is needed in production or
 * staging; one may be passed directly for isolated client tests.
 */
import { uuidv4 } from './uuid.js';

/**
 * @param {Object} [opts]
 * @param {string} [opts.baseUrl] same-origin by default; override for dev
 * @param {string} [opts.selfActor]
 * @param {(path:string, init?:RequestInit)=>Promise<Response>} [opts.fetchImpl]
 */
export function createLiveClient(opts = {}) {
  const baseUrl = (opts.baseUrl || '').replace(/\/$/, '');
  let selfActor = opts.selfActor || null;
  const fetchImpl = opts.fetchImpl || ((path, init) => fetch(`${baseUrl}${path}`, init));
  let rpcId = 0;

  async function rpc(verb, args = {}) {
    const res = await fetchImpl('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name: verb, arguments: args },
      }),
    });
    if (!res.ok) {
      // The status is the only thing that says whether this request was DECIDED
      // or merely unanswered, and throwing it away made every failure look the
      // same to a caller. A 401 or 403 is a decision taken before the verb ever
      // ran: the change was not saved, and inviting a retry would be wrong. A
      // 5xx, a proxy's 502, a gateway timeout is the path failing around a
      // request that may well have been applied. Callers need to tell those apart.
      //
      // The BODY does not go into the message. A 500's body is a server stack
      // written for whoever maintains the verb — it is not a statement about this
      // deal, and this page prints `error.message` at partners. It travels on the
      // error for the console and for a bug report, and no surface renders it.
      const body = await res.text().catch(() => '');
      const error = new Error(`live ${verb} -> HTTP ${res.status}`);
      error.status = res.status;
      error.body = body.slice(0, 500);
      throw error;
    }
    const envelope = await res.json();
    if (envelope.error) throw new Error(`live ${verb} rpc error: ${envelope.error.message}`);
    const payload = JSON.parse(envelope.result?.content?.[0]?.text ?? 'null');
    if (envelope.result?.isError) {
      const err = new Error(`live ${verb} refused: ${payload?.error || 'tool_error'}`);
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  async function write(verb, args) {
    return rpc(verb, { ...args, idempotency_key: args.idempotency_key || uuidv4() });
  }

  // The record layer speaks phase SLUGS (deal_phase table); the board speaks
  // the display names the mockup ruled. Translate at the client boundary in
  // both directions so neither side ever sees the other's vocabulary.
  //
  // The map is ONE-TO-ONE, and that is the repair in V5-UX-B03. It used to send
  // both `research` and `site_selection` to "Research" while UI_TO_PHASE had no
  // entry for site selection at all, so a board that read a site-selection deal
  // showed it as Research and wrote `research` back — silently relocating the
  // record to a phase nobody chose (defect 5e355b84). Every slug now has its own
  // label and every label its own slug, so a round trip returns what it started
  // with.
  const PHASE_TO_UI = {
    pending: 'On Deck', research: 'Research', site_selection: 'Site selection',
    negotiation: 'Negotiation', legal: 'Legal', due_diligence: 'Diligence',
    closing: 'Closing', closed: 'Closed',
  };
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
  });

  const client = {
    mode: /** @type {const} */ ('live'),
    get selfActor() { return selfActor; },

    // Each deal carries `field_base` — the latest committed event id and time for
    // every editable cell, read in the same statement as the values it belongs
    // to. It passes through untouched: it is the record layer's own identity for
    // an event, in the record layer's own field vocabulary, and translating or
    // rebuilding it would be inventing one.
    async getBoard(options = {}) {
      const board = await rpc('deal-room-board', {
        workspace: options.workspace || 'all',
        ...(options.account_client_id ? { account_client_id: options.account_client_id } : {}),
      });
      selfActor = board.actor || selfActor;
      return { ...board, deals: (board.deals || []).map(dealToUi) };
    },

    async getDeal(dealId) {
      const page = await rpc('get-deal-room', { deal: dealId });
      const { thread = [], critical_dates = [], events = [], deal_id, ...fields } = page;
      // Thread: the newest next_step IS the cell's current step; older
      // next_step rows are the archive the ruling requires ("supersede,
      // never erase"). Notes pass through.
      let currentSeen = false;
      const uiThread = [];
      let currentStep = null;
      for (const n of thread) {
        if (n.kind === 'next_step') {
          if (!currentSeen) { currentSeen = true; currentStep = n.text; continue; }
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
        deal: dealToUi({ id: deal_id, ...fields, next_step: currentStep || fields.next_step || '' }),
        thread: uiThread,
        critical_dates: critical_dates.map((cd) => ({ ...cd, label: cd.note || cd.kind, date: cd.due_on })),
        history,
        next_actions: page.next_actions || [],
        activities: page.activities || [],
        participants: page.participants || [],
        premises: page.premises || [],
        negotiation_rounds: page.negotiation_rounds || [],
        documents: page.documents || [],
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

    async getChanges(cursor) {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const res = await fetchImpl(`/pipeline/changes${q}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`live changes -> ${res.status}`);
      const data = await res.json();
      for (const e of data.events || []) {
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

    async addDealNote(args) {
      return write('add-deal-note', args);
    },

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
      const res = await write('new-deal', {
        client: args.client,
        name: args.name,
        deal_type: args.deal_type || 'other',
        phase: UI_TO_PHASE[args.phase] || args.phase || 'pending',
        segment: args.segment || undefined,
        city: args.market || undefined,
        lane: args.lane || 'territory',
        reason: 'Created in the Deal Room',
        idempotency_key: args.idempotency_key,
      });
      await write('set-lead', { deal: res.deal_id, new_lead: selfActor });
      return { status: 'ok', deal_id: res.deal_id };
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
    async loopBoard(args = {}) { return rpc('loop-board', args); },
    async readLoop(args = {}) { return rpc('read-loop', args); },
    async loopHeaders(args = {}) { return rpc('loop-headers', args); },
    async addLoop(args) { return write('add-loop', args); },
    async updateLoop(args) { return write('update-loop', args); },
    async closeLoop(args) { return write('close-loop', args); },

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
      const res = await fetchImpl('/api/v1/command-center', {
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
    async engineeringPassport(args = {}) { return rpc('engineering-passport', args); },
    async readPortfolio(args = {}) { return rpc('read-portfolio', args); },
    async workRequestCard(args = {}) { return rpc('work-request-card', args); },
    async declineWorkRequest(args) { return write('decline-work-request', args); },
    async supersedeWorkRequest(args) { return write('supersede-work-request', args); },
    async setWorkShapeDisposition(args) { return write('set-work-shape-disposition', args); },

    // ------------------------------------------------------ Control Room (C01)
    // Three read-only verbs, passed through untouched. Two of them take NO
    // arguments at all and refuse any field, so nothing is defaulted in here:
    // a tenant, an owner or a filter invented by the browser is exactly what
    // those verbs exist to refuse.
    async incidentBoard(args = {}) { return rpc('incident-board', args); },
    async currentWorkItem() { return rpc('current-work-item', {}); },
    async currentWorkRequests() { return rpc('current-work-requests', {}); },

    async startReview(args) { return write('start-deal-review', args); },
    async reviewDeal(args) { return write('review-deal', args); },
    async endReview(args) { return write('end-deal-review', args); },
    async setMarketAgent(args) { return write('set-market-agent', args); },
    async setNationalAccountOwner(args) { return write('set-national-account-owner', args); },
    async createNationalAccount(args) { return write('create-national-account', args); },
    async createNationalMarketDeal(args) { return write('create-national-market-deal', args); },
    async revertDealField(args) { return write('revert-deal-field', args); },
  };
  return client;
}
