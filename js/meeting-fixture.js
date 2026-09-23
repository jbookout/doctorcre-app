// V5-UX-B11 — the synthetic Meeting Mode store the fixture adapter serves.
//
// A copy of CARR migration 0556's decisions (carr-system 35009e9d), not an
// approximation of them: the fixture has to refuse, dedupe and fence exactly as
// the store does, or the suite certifies a kinder producer than the real one.
// One store can back several fixture clients, which is how a test puts two
// devices and two partners into the SAME meeting.
//
// The canonical envelope is modelled too: a key replays its stored answer, and
// the same key with different arguments is refused as `key_reuse`. `ledger` is
// the public.tool_call stand-in — the only evidence record-meeting-action-outcome
// accepts that a canonical verb committed.
import { MEETING_SCHEMA_VERSION, RECORDING_FRAGMENTS, recordingFieldPaths } from "./meeting-model.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:/@!+=-]{0,127}$/;
const LEASE_TTL_MS = 120_000;
const PARTNER_ACTORS = new Set(["joe", "dell"]);

function refuse(verb, code, extra = {}) {
  const error = new Error(`fixture ${verb} refused: ${code}`);
  error.payload = { error: code, ...extra };
  throw error;
}

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const stable = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
};

/** One shared synthetic store. `now` is injectable so a lease can lapse in a test. */
export function createMeetingStore({ now = () => Date.now() } = {}) {
  return {
    now,
    meetings: new Map(),
    envelope: new Map(),
    ledger: new Map(),
  };
}

export function meetingFixtureMethods(store, { actor, tenant = "demo-tenant", outage = null, dispatchCanonical = null }) {
  const iso = () => new Date(store.now()).toISOString();
  const isPartner = PARTNER_ACTORS.has(actor);

  /** The canonical envelope: validate names, replay a key, refuse a reused one. */
  function envelope(verb, args, fn) {
    const paths = recordingFieldPaths(args);
    if (paths.length) {
      const fragment = RECORDING_FRAGMENTS.find((f) => paths[0].toLowerCase().includes(f));
      refuse(verb, "recording_field_refused", { path: paths[0], fragment, recording: "denied" });
    }
    if (!UUID.test(String(args?.idempotency_key ?? ""))) refuse(verb, "idempotency_key_invalid", { hint: "idempotency_key is a uuid" });
    const { idempotency_key: key, ...rest } = args;
    const signature = stable({ verb, rest, actor });
    const seen = store.envelope.get(key);
    if (seen) {
      if (seen.signature !== signature) refuse(verb, "key_reuse", { idempotency_key: key });
      return { ...clone(seen.response), replayed: true };
    }
    const response = fn();
    store.envelope.set(key, { signature, response: clone(response) });
    if (store.ledger && verb) store.ledger.set(key, { verb, actor, tenant, at: iso(), response: clone(response) });
    return response;
  }

  function meetingOr(verb, id) {
    const m = store.meetings.get(id);
    if (!m || m.tenant !== tenant) refuse(verb, "meeting_not_found", { meeting_id: id });
    return m;
  }

  function append(m, kind, instance, key, { note = null, action = null, revision = null, epoch = null } = {}) {
    if (m.stream.some((s) => s.idempotency_key === key && s.kind === kind)) return null;
    m.last_seq += 1;
    m.stream.push({ seq: m.last_seq, kind, actor, client_instance: instance, note_number: note,
      action_number: action, revision, lease_epoch: epoch, at: iso(), idempotency_key: key });
    return m.last_seq;
  }

  function actionView(m, number) {
    const a = m.actions.get(number);
    const current = a.revisions.find((r) => r.revision === a.current_revision);
    const decided = a.decided_revision ? a.revisions.find((r) => r.revision === a.decided_revision) : null;
    return {
      action_number: a.action_number, state: a.state, current_revision: a.current_revision,
      decided_revision: a.decided_revision, decided_by: a.decided_by, disposition: a.disposition,
      assignee: a.assignee, command: clone(current.command),
      dispatch: a.operation_key ? { verb: decided.command.verb, args: clone(decided.command.args), idempotency_key: a.operation_key } : null,
      outcome: clone(a.outcome),
    };
  }

  function accept(m, a, revision, disposition, assignee, instance, key) {
    Object.assign(a, { state: "accepted", decided_revision: revision, decided_by: actor, decided_at: iso(),
      disposition, assignee, operation_key: crypto.randomUUID() });
    append(m, "action_accepted", instance, key, { action: a.action_number, revision });
  }

  function recap(actions) {
    const out = { done: [], delegated: [], needs_approval: [], unresolved: [], closed_without_action: [] };
    for (const action of actions) {
      const current = action.revisions.find((r) => r.revision === action.current_revision) ?? action.revisions.at(-1) ?? {};
      const entry = { action_number: action.action_number, summary: current.summary ?? null, state: action.state, assignee: action.assignee ?? null };
      if (action.state === "executed") out.done.push({ ...entry, reason_id: "canonical_effect_reconciled" });
      else if (action.state === "delegated") out.delegated.push({ ...entry, reason_id: "canonical_handoff_reconciled" });
      else if (action.state === "declined") out.closed_without_action.push({ ...entry, reason_id: "declined_by_partner" });
      else if (action.state === "accepted") out.unresolved.push({ ...entry, reason_id: "accepted_effect_not_yet_observed" });
      else if (action.state === "proposed" && current.command) out.needs_approval.push({ ...entry, reason_id: "proposed_command_awaits_partner" });
      else out.unresolved.push({ ...entry, reason_id: "tentative_discussion_without_command" });
    }
    return out;
  }

  function leaseView(m) {
    const l = m.lease;
    if (!l) return null;
    return { holder: l.holder, holder_instance: l.holder_instance, lease_epoch: l.lease_epoch,
      expires_at: new Date(l.expires_at).toISOString(), released: l.released_at !== null,
      live: l.released_at === null && l.expires_at > store.now() };
  }

  const base = { schema_version: MEETING_SCHEMA_VERSION, recording: "denied" };

  return {
    async startMeeting(args) {
      return envelope("start-meeting", args, () => {
        if (!IDENT.test(String(args.client_instance))) refuse("start-meeting", "client_instance_invalid");
        if (["automatic_on_detection", "inherited_from_previous_meeting", "silent_activation"].includes(args.activation_intent)) {
          refuse("start-meeting", "silent_activation_refused", { accepted_activation_intent: "one_tap_user_activation" });
        }
        if (args.activation_intent !== "one_tap_user_activation") refuse("start-meeting", "explicit_human_activation_required");
        if (!isPartner) refuse("start-meeting", "meeting_start_requires_verified_partner");
        const identity = args.native_identity || {};
        const nativeKey = `${tenant}|${args.platform || ""}|${identity.source_system}|${identity.native_id}|${identity.native_id_epoch}`;
        const existing = [...store.meetings.values()].find((m) => m.native_key === nativeKey);
        if (!existing) {
          if (store.meetings.has(args.idempotency_key)) refuse("start-meeting", "meeting_idempotency_key_reuse");
          const m = {
            id: args.idempotency_key, tenant, native_key: nativeKey, platform: args.platform || null,
            native_identity: { ...identity }, title: args.title, mode_state: "active_non_recording",
            recording: "denied", activation_intent: args.activation_intent, started_by: actor, started_at: iso(),
            ended_by: null, ended_at: null, last_seq: 0, last_note_number: 0, last_action_number: 0,
            notes: [], actions: new Map(), stream: [], lease: null,
          };
          store.meetings.set(m.id, m);
          append(m, "meeting_started", args.client_instance, args.idempotency_key);
          return { ok: true, ...base, deduplicated: false, joined_existing: false, meeting_id: m.id, title: m.title,
            mode_state: m.mode_state, started_by: actor, last_seq: m.last_seq, records_audio: false };
        }
        let seq = null;
        if (existing.mode_state !== "ended") seq = append(existing, "meeting_joined", args.client_instance, args.idempotency_key);
        return { ok: true, ...base, deduplicated: seq === null && existing.mode_state !== "ended", joined_existing: true,
          meeting_id: existing.id, title: existing.title, mode_state: existing.mode_state,
          started_by: existing.started_by, last_seq: existing.last_seq, records_audio: false };
      });
    },

    async claimMeetingProcessing(args) {
      return envelope("claim-meeting-processing", args, () => {
        const m = meetingOr("claim-meeting-processing", args.meeting_id);
        const t = store.now();
        const l = m.lease;
        const holder = l && l.holder === actor && l.holder_instance === args.client_instance && l.released_at === null;
        let decision;
        if (args.release === true) {
          if (!holder) decision = "not_holder";
          else {
            l.released_at = t;
            append(m, "processing_released", args.client_instance, args.idempotency_key, { epoch: l.lease_epoch });
            decision = "released";
          }
        } else if (m.mode_state === "ended") {
          refuse("claim-meeting-processing", "meeting_ended", { meeting_id: m.id });
        } else if (!l) {
          m.lease = { holder: actor, holder_instance: args.client_instance, lease_epoch: 1, acquired_at: t, expires_at: t + LEASE_TTL_MS, released_at: null };
          append(m, "processing_acquired", args.client_instance, args.idempotency_key, { epoch: 1 });
          decision = "acquired";
        } else if (holder) {
          l.expires_at = t + LEASE_TTL_MS;
          decision = "renewed";
        } else if (l.released_at === null && l.expires_at > t) {
          decision = "held_by_other";
        } else {
          Object.assign(l, { holder: actor, holder_instance: args.client_instance, lease_epoch: l.lease_epoch + 1,
            acquired_at: t, expires_at: t + LEASE_TTL_MS, released_at: null });
          append(m, "processing_taken_over", args.client_instance, args.idempotency_key, { epoch: l.lease_epoch });
          decision = "taken_over_after_expiry";
        }
        const now = m.lease;
        return { ok: true, ...base, meeting_id: m.id, decision,
          is_holder: Boolean(now && now.released_at === null && now.holder === actor && now.holder_instance === args.client_instance),
          lease: now ? { holder: now.holder, holder_instance: now.holder_instance, lease_epoch: now.lease_epoch,
            expires_at: new Date(now.expires_at).toISOString(), released: now.released_at !== null } : null };
      });
    },

    async addMeetingNote(args) {
      return envelope("add-meeting-note", args, () => {
        const m = meetingOr("add-meeting-note", args.meeting_id);
        if (m.mode_state === "ended") refuse("add-meeting-note", "meeting_ended", { meeting_id: m.id });
        let number;
        let revision;
        if (args.revises_note_number === undefined || args.revises_note_number === null) {
          if (args.base_revision !== undefined && args.base_revision !== null) refuse("add-meeting-note", "meeting_note_base_revision_without_note");
          m.last_note_number += 1;
          number = m.last_note_number;
          revision = 1;
        } else {
          const revisions = m.notes.filter((n) => n.note_number === args.revises_note_number).map((n) => n.revision);
          if (!revisions.length) refuse("add-meeting-note", "meeting_note_not_found", { note_number: args.revises_note_number });
          const current = Math.max(...revisions);
          if (args.base_revision !== current) refuse("add-meeting-note", "meeting_note_revision_conflict", { note_number: args.revises_note_number, current_revision: current });
          number = args.revises_note_number;
          revision = current + 1;
        }
        m.notes.push({ note_number: number, revision, body: args.body, author: actor, author_instance: args.client_instance, at: iso() });
        append(m, revision === 1 ? "note_added" : "note_revised", args.client_instance, args.idempotency_key, { note: number, revision });
        return { ok: true, ...base, deduplicated: false, meeting_id: m.id, note_number: number, revision, seq: m.last_seq };
      });
    },

    async proposeMeetingAction(args) {
      return envelope("propose-meeting-action", args, () => {
        const verb = "propose-meeting-action";
        if (!["tentative_discussion", "explicit_instruction"].includes(args.basis)) refuse(verb, "meeting_action_basis_invalid");
        if (args.command && Object.hasOwn(args.command.args || {}, "idempotency_key")) refuse(verb, "meeting_command_idempotency_key_refused");
        const m = meetingOr(verb, args.meeting_id);
        if (m.mode_state === "ended") refuse(verb, "meeting_ended", { meeting_id: m.id });
        const epoch = args.processing_epoch ?? null;
        if (epoch !== null) {
          const l = m.lease;
          if (!l || l.released_at !== null || l.expires_at <= store.now() || l.holder !== actor
              || l.holder_instance !== args.client_instance || l.lease_epoch !== epoch) {
            refuse(verb, "stale_processing_lease", { current_lease_epoch: l?.lease_epoch ?? null });
          }
        }
        const command = args.command ? { verb: args.command.verb, args: clone(args.command.args) } : null;
        let head = null;
        if (args.revises_action_number !== undefined && args.revises_action_number !== null) {
          head = m.actions.get(args.revises_action_number);
          if (!head) refuse(verb, "meeting_action_not_found", { action_number: args.revises_action_number });
          if (head.state !== "proposed") refuse(verb, "meeting_action_no_longer_pending", { action: actionView(m, head.action_number) });
          if (args.base_revision !== head.current_revision) refuse(verb, "meeting_action_revision_conflict", { action: actionView(m, head.action_number) });
        } else if (args.dedupe_key) {
          head = [...m.actions.values()].find((a) => a.dedupe_key === args.dedupe_key) || null;
          if (head && head.state !== "proposed") {
            return { ok: true, ...base, deduplicated: true, already_resolved: true, accepted_as_explicit_instruction: false,
              meeting_id: m.id, revision: null, action: actionView(m, head.action_number), seq: null };
          }
        } else if (args.base_revision !== undefined && args.base_revision !== null) {
          refuse(verb, "meeting_action_base_revision_without_action");
        }
        let number;
        let revision;
        if (head) {
          const latest = head.revisions.find((r) => r.revision === head.current_revision);
          if (latest.summary === args.summary && stable(latest.command) === stable(command) && latest.basis === args.basis) {
            return { ok: true, ...base, deduplicated: true, already_resolved: false, accepted_as_explicit_instruction: false,
              meeting_id: m.id, revision: head.current_revision, action: actionView(m, head.action_number), seq: null };
          }
          number = head.action_number;
          revision = head.current_revision + 1;
          head.current_revision = revision;
        } else {
          m.last_action_number += 1;
          number = m.last_action_number;
          revision = 1;
          head = { action_number: number, dedupe_key: args.dedupe_key || null, state: "proposed", current_revision: 1,
            decided_revision: null, decided_by: null, decided_at: null, disposition: null, assignee: null,
            operation_key: null, outcome: null, revisions: [] };
          m.actions.set(number, head);
        }
        head.revisions.push({ revision, summary: args.summary, command, basis: args.basis,
          source: epoch === null ? "participant" : "processing", processing_epoch: epoch,
          proposed_by: actor, proposed_by_instance: args.client_instance, at: iso() });
        append(m, revision === 1 ? "action_proposed" : "action_revised", args.client_instance, args.idempotency_key, { action: number, revision });
        let accepted = false;
        if (epoch === null && isPartner && args.basis === "explicit_instruction" && command) {
          accept(m, head, revision, "execute", actor, args.client_instance, args.idempotency_key);
          accepted = true;
        }
        return { ok: true, ...base, deduplicated: false, already_resolved: false, accepted_as_explicit_instruction: accepted,
          meeting_id: m.id, revision, action: actionView(m, number), seq: m.last_seq };
      });
    },

    async decideMeetingAction(args) {
      return envelope("decide-meeting-action", args, () => {
        const verb = "decide-meeting-action";
        if (!isPartner) refuse(verb, "meeting_decision_requires_verified_partner");
        const m = meetingOr(verb, args.meeting_id);
        const head = m.actions.get(args.action_number);
        if (!head) refuse(verb, "meeting_action_not_found", { action_number: args.action_number });
        const view = () => actionView(m, head.action_number);
        const answer = (extra) => ({ ok: true, ...base, deduplicated: false, already: false, resolved_once: false,
          meeting_id: m.id, ...extra, action: view(), dispatch: view().dispatch, effect_executed: false });
        if (head.state !== "proposed") {
          if (args.decision === "accept" && ["accepted", "executed", "delegated"].includes(head.state)) return answer({ already: true, resolved_once: true });
          if (args.decision === "decline" && head.state === "declined") return answer({ already: true });
          refuse(verb, head.state === "declined" ? "meeting_action_already_declined" : "meeting_action_already_accepted_requires_correction", { action: view() });
        }
        if (args.base_revision !== head.current_revision) refuse(verb, "meeting_action_revised_since_read", { action: view() });
        if (args.decision === "decline") {
          Object.assign(head, { state: "declined", decided_revision: head.current_revision, decided_by: actor, decided_at: iso() });
          append(m, "action_declined", args.client_instance, args.idempotency_key, { action: head.action_number, revision: head.current_revision });
          return answer({});
        }
        const latest = head.revisions.find((r) => r.revision === head.current_revision);
        if (!latest.command) refuse(verb, "meeting_action_has_no_canonical_command", { action: view() });
        const disposition = args.disposition || "execute";
        if (!args.assignee_slug && disposition === "delegate") refuse(verb, "meeting_delegation_requires_assignee");
        if (args.assignee_slug && !PARTNER_ACTORS.has(args.assignee_slug)) refuse(verb, "meeting_assignee_not_found");
        accept(m, head, head.current_revision, disposition, args.assignee_slug || actor, args.client_instance, args.idempotency_key);
        return answer({ resolved_once: true });
      });
    },

    async recordMeetingActionOutcome(args) {
      return envelope("record-meeting-action-outcome", args, () => {
        const verb = "record-meeting-action-outcome";
        const m = meetingOr(verb, args.meeting_id);
        const head = m.actions.get(args.action_number);
        if (!head) refuse(verb, "meeting_action_not_found", { action_number: args.action_number });
        const view = () => actionView(m, head.action_number);
        const result = (extra) => ({ ok: true, ...base, already: false, reconciled: false, outcome_state: null, meeting_id: m.id, retry: null, ...extra, action: view() });
        if (["executed", "delegated"].includes(head.state)) return result({ already: true, reconciled: true, outcome_state: head.state });
        if (head.state !== "accepted") refuse(verb, "meeting_action_not_accepted", { action: view() });
        const decided = head.revisions.find((r) => r.revision === head.decided_revision);
        const call = store.ledger.get(head.operation_key);
        if (!call) {
          return result({ outcome_state: "not_observed", retry: { verb: decided.command.verb, args: clone(decided.command.args),
            idempotency_key: head.operation_key, rule: "retry only with this exact idempotency_key; never mint a new one" } });
        }
        if (call.verb !== decided.command.verb || call.tenant !== m.tenant) refuse(verb, "meeting_operation_key_bound_elsewhere", { observed_verb: call.verb, action: view() });
        const state = head.disposition === "delegate" ? "delegated" : "executed";
        head.state = state;
        head.outcome = { verb: call.verb, idempotency_key: head.operation_key, committed_at: call.at, committed_by: call.actor,
          response_digest: "sha256:fixture", evidence: "public.tool_call" };
        append(m, state === "delegated" ? "action_delegated" : "action_executed", args.client_instance, args.idempotency_key,
          { action: head.action_number, revision: head.decided_revision });
        return result({ reconciled: true, outcome_state: state });
      });
    },

    async endMeeting(args) {
      return envelope("end-meeting", args, () => {
        if (!isPartner) refuse("end-meeting", "meeting_end_requires_verified_partner");
        const m = meetingOr("end-meeting", args.meeting_id);
        if (m.mode_state === "ended") return { ok: true, ...base, already: true, meeting_id: m.id, ended_at: m.ended_at };
        Object.assign(m, { mode_state: "ended", ended_at: iso(), ended_by: actor });
        if (m.lease && m.lease.released_at === null) m.lease.released_at = store.now();
        append(m, "meeting_ended", args.client_instance, args.idempotency_key);
        return { ok: true, ...base, already: false, meeting_id: m.id, ended_at: m.ended_at };
      });
    },

    async readMeeting({ meeting_id, after_seq = 0, limit = null } = {}) {
      if (outage === "meeting") {
        const error = new Error("fixture outage: read-meeting is unreachable");
        error.status = 503;
        throw error;
      }
      if (!UUID.test(String(meeting_id ?? ""))) refuse("read-meeting", "meeting_not_found");
      const m = meetingOr("read-meeting", meeting_id);
      const size = Math.min(Math.max(limit ?? 200, 1), 500);
      const after = after_seq ?? 0;
      const actions = [...m.actions.values()].sort((a, b) => a.action_number - b.action_number);
      const buckets = recap(actions);
      const lease = leaseView(m);
      const ended = m.mode_state === "ended";
      return {
        ok: true,
        schema_version: MEETING_SCHEMA_VERSION,
        meeting: { id: m.id, title: m.title, platform: m.platform, native_identity: { ...m.native_identity },
          mode_state: m.mode_state, recording: m.recording, activation_intent: m.activation_intent,
          started_by: m.started_by, started_at: m.started_at, ended_by: m.ended_by, ended_at: m.ended_at, last_seq: m.last_seq },
        lease,
        notes: [...m.notes].sort((a, b) => a.note_number - b.note_number || a.revision - b.revision).map(clone),
        actions: actions.map((a) => ({ ...actionView(m, a.action_number), revisions: a.revisions.map(clone) })),
        stream: m.stream.filter((s) => s.seq > after).slice(0, size).map(({ idempotency_key: _k, ...s }) => clone(s)),
        more: m.stream.some((s) => s.seq > after + size),
        recap: { ...buckets, counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])) },
        status: { recording: "never_started", processing_complete: ended && !(lease && lease.live === true),
          review_complete: buckets.needs_approval.length === 0 && buckets.unresolved.length === 0 },
        recording: "denied",
        records_audio: false,
        recording_policy_seam: "fixture",
        d03_recording: { available: false, reason_id: "requires_actual_recording_retention_and_activation_evidence", legacy_recorder_presence_is_evidence: false },
        detection_prompt: { available: false, reason_id: "prompt_ledger_owner_absent", seam: "fixture" },
      };
    },

    /**
     * The canonical call an accepted action names, made through the fixture's
     * own verb and recorded in the ledger under the STORE's key. Nothing here
     * mints a key; a verb the app does not carry is refused.
     */
    async dispatchMeetingCommand({ verb, args, idempotency_key }) {
      if (!UUID.test(String(idempotency_key ?? ""))) refuse(verb, "idempotency_key_invalid");
      const seen = store.envelope.get(idempotency_key);
      const signature = stable({ verb, rest: args, actor });
      if (seen) {
        if (seen.signature !== signature) refuse(verb, "key_reuse", { idempotency_key });
        return { ...clone(seen.response), replayed: true };
      }
      if (typeof dispatchCanonical !== "function") refuse(verb, "unregistered_operation");
      const response = await dispatchCanonical(verb, { ...args, idempotency_key });
      store.envelope.set(idempotency_key, { signature, response: clone(response) });
      store.ledger.set(idempotency_key, { verb, actor, tenant, at: iso(), response: clone(response) });
      return response;
    },
  };
}
