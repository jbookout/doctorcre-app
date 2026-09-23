// V5-UX-B11 — what the shared Meeting Mode page shows and sends, decided
// without a DOM.
//
// The producer is CARR `mcp-server/src/meeting-mode.js` over migration 0556
// (carr-system 35009e9d). Every rule below is a reading of what those eight
// verbs can actually do, and each exists because the alternative would let the
// page say something the record layer cannot back.
//
//   1. ONE MEETING PER NATIVE IDENTITY. `start-meeting` keys the meeting on its
//      native source identity, and the winning start's idempotency key BECOMES
//      the meeting id. A second device JOINS by sending that same identity, which
//      it reads from `read-meeting`; it never mints a second meeting.
//   2. ONE LOGICAL OPERATION, ONE KEY. Every write is claimed through the shared
//      command kernel under an operation key named here, so a double click, a
//      reconnect and a reload re-send the SAME frozen request (see
//      meeting-memory.mjs for the reload half).
//   3. A PROPOSAL IS NEVER A RECORD EFFECT. Only `executed` and `delegated`
//      carry reconciled canonical evidence, and only those are drawn as done.
//      `accepted` means a partner decided; it is "effect not yet observed" until
//      `record-meeting-action-outcome` finds the canonical verb's own committed
//      row under the action's operation key.
//   4. RECONCILE BEFORE RETRY. An accepted action is finished by reconciling
//      first; only a `not_observed` answer licenses a dispatch, and that dispatch
//      reuses the operation key the store minted — this app never mints one.
//   5. NOTHING HERE LISTENS. No field name reaches for audio, a recording or a
//      transcript, and a payload that does not say recording is denied is not
//      drawn at all.
import { formatClock } from "./visual-system.js";

export const MEETING_SCHEMA_VERSION = "doctorcre-meeting-mode.v1";

/** The producer's own uuid shape (`meeting-mode.js:63`), copied exactly. */
export const MEETING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The producer's identifier shape for client_instance, dedupe keys and native ids. */
export const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:/@!+=-]{0,127}$/;
// C0/C1 controls (tab and newline allowed), zero-width and bidi overrides.
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]", "u");

/** J201's recording fragments (`meeting-call-mode-j201.v5.js`), the one list. */
export const RECORDING_FRAGMENTS = Object.freeze([
  "audio", "capture", "diariz", "listen", "mic", "pcm", "record",
  "speech", "stream", "transcri", "voice", "waveform",
]);

/** The only activation the store accepts: a signed-in partner's own tap. */
export const ACTIVATION_INTENT = "one_tap_user_activation";
/** The source system an app-minted ad-hoc meeting is keyed under. */
export const APP_SOURCE_SYSTEM = "doctorcre-app";

export const MEETING_WRITE_VERBS = Object.freeze([
  "start-meeting", "claim-meeting-processing", "add-meeting-note", "propose-meeting-action",
  "decide-meeting-action", "record-meeting-action-outcome", "end-meeting",
]);
export const MEETING_VERBS = Object.freeze([...MEETING_WRITE_VERBS, "read-meeting"]);

/**
 * The canonical verbs this app will itself make for an accepted action. Any
 * other verb stays accepted-and-unobserved here: the app does not carry it, and
 * it will not pretend to.
 */
export const DISPATCHABLE_VERBS = Object.freeze(["add-loop"]);

/** The two partners, as slug and as the owner label `add-loop` writes. */
export const PARTNERS = Object.freeze([
  Object.freeze({ slug: "joe", owner: "Joe" }),
  Object.freeze({ slug: "dell", owner: "Dell" }),
]);

/** The server's lease length (`ops.meeting_processing_lease_ttl`). Renew well inside it. */
export const LEASE_RENEW_MS = 60_000;
export const STREAM_PAGE = 200;

/* --------------------------------------------------------------- the sentences */

export const NO_RECORDING =
  "This meeting captures no audio. Nothing here listens, records or transcribes: notes and actions are only what a partner types.";
export const D03_DEFERRED =
  "Recording is a separate, later capability. It needs its own recording, retention and activation evidence; an old recorder existing somewhere is not that evidence.";
export const DETECTION_UNAVAILABLE =
  "Meetings are never started for you. Nothing detects a call and prompts; a meeting starts only when a partner taps Start here.";
export const PROPOSAL_IS_NOT_DONE =
  "A proposal is a question, not a result. Only an action whose record effect has been confirmed is shown as done.";

export const TITLE_REFUSAL = "A meeting needs a title of 1 to 200 characters on one line. Nothing was sent.";
export const NOTE_REFUSAL = "A note needs 1 to 20,000 characters. Nothing was sent.";
export const SUMMARY_REFUSAL = "An action needs a summary of 1 to 2,000 characters. Nothing was sent.";
export const FOLLOW_UP_REFUSAL = "A follow-up needs a task title and an owner. Nothing was sent.";
export const INSTRUCTION_REFUSAL = "Do it now needs a follow-up to run. Without one, propose it instead. Nothing was sent.";
export const NOT_READ_REFUSAL = "This page has not read the meeting yet. Nothing was sent.";
export const ENDED_REFUSAL = "This meeting has ended. Notes and new actions are closed; open actions can still be decided.";
export const REVISION_REFUSAL = "This page has not read the revision it would change. Nothing was sent.";

/* ------------------------------------------------------------------- the route */

/** `?id=` alone. A bare page offers Start; a malformed id says so. */
export function meetingRoute(search) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  const raw = params.get("id");
  if (raw === null || raw.trim() === "") return { state: "missing", id: null, given: null };
  const id = raw.trim();
  if (!MEETING_ID.test(id)) return { state: "malformed", id: null, given: id };
  return { state: "ok", id, given: id };
}

/* ------------------------------------------------------------ the device name */

export const INSTANCE_KEY = "doctorcre:meeting-instance:v1";

/**
 * This device's client_instance: attribution only, never authority. It is kept
 * on the device so a reload is the same instance and still holds its lease.
 */
export function clientInstanceFor(storage, newId) {
  try {
    const held = storage?.getItem(INSTANCE_KEY);
    if (held && IDENT.test(held)) return held;
  } catch { /* storage refused: fall through to a session-only name */ }
  const minted = `app-${newId()}`;
  try { storage?.setItem(INSTANCE_KEY, minted); } catch { /* session-only */ }
  return minted;
}

/* ---------------------------------------------------------- the recording guard */

/**
 * Every argument NAME, at any depth, that reaches for audio, a recording or a
 * transcript. The producer refuses these before its store runs; the page refuses
 * them before anything is sent, so the two lists cannot drift without a test
 * noticing.
 */
export function recordingFieldPaths(value, path = "args") {
  if (Array.isArray(value)) return value.flatMap((entry, i) => recordingFieldPaths(entry, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  const found = [];
  for (const key of Object.keys(value)) {
    const lower = key.toLowerCase();
    if (RECORDING_FRAGMENTS.some((fragment) => lower.includes(fragment))) found.push(`${path}.${key}`);
    found.push(...recordingFieldPaths(value[key], `${path}.${key}`));
  }
  return found;
}

/* ----------------------------------------------------------------- the payload */

const isText = (value) => typeof value === "string" && value.length > 0;

/**
 * `read-meeting`'s own shape. A payload that does not say recording is denied
 * and records_audio is false is NOT drawn: a page that rendered it would be
 * showing a meeting this slice is forbidden to hold.
 */
export function validMeetingPayload(payload) {
  if (!payload || typeof payload !== "object" || payload.ok !== true) return false;
  if (payload.schema_version !== MEETING_SCHEMA_VERSION) return false;
  const meeting = payload.meeting;
  if (!meeting || typeof meeting !== "object" || !MEETING_ID.test(String(meeting.id))) return false;
  if (!isText(meeting.title) || !["active_non_recording", "ended"].includes(meeting.mode_state)) return false;
  if (meeting.recording !== "denied" || payload.recording !== "denied" || payload.records_audio !== false) return false;
  if (!Array.isArray(payload.notes) || !Array.isArray(payload.actions) || !Array.isArray(payload.stream)) return false;
  return Boolean(payload.recap && typeof payload.recap === "object");
}

export const MEETING_STATES = Object.freeze({
  start: "No meeting is open. Start one with a single tap, or open a meeting link a partner shared.",
  loading: "Reading this meeting…",
  ready: "",
  not_found: "No meeting with that link is visible to you. It may not exist, or it may belong to another workspace — the record layer answers those the same way.",
  malformed: "That link does not carry a meeting id.",
  unavailable: "The meeting did not answer. Your notes and drafts are kept on this device; nothing was retried for you.",
  refused: "The record layer refused this read. It was decided before the verb ran, and nothing was read.",
  invalid: "The record layer answered with something this page will not draw: it did not say recording is denied.",
});

/** A failed read, from its STATUS and CODE alone. The server's prose never travels. */
export function classifyMeetingReadFailure(error) {
  const code = error?.payload?.error || null;
  const status = Number(error?.status ?? 0) || null;
  if (code === "meeting_not_found") return { state: "not_found", sentence: MEETING_STATES.not_found };
  if (status === 401 || status === 403) return { state: "refused", sentence: MEETING_STATES.refused };
  return { state: "unavailable", sentence: MEETING_STATES.unavailable };
}

export function meetingState(read = {}, route = { state: "ok" }) {
  if (route?.state === "missing") return { state: "start", sentence: MEETING_STATES.start };
  if (route?.state === "malformed") return { state: "malformed", sentence: MEETING_STATES.malformed };
  if (["refused", "not_found", "unavailable", "invalid"].includes(read.state)) {
    return { state: read.state, sentence: read.sentence || MEETING_STATES[read.state] };
  }
  if (read.state === "read") {
    return validMeetingPayload(read.payload)
      ? { state: "ready", sentence: null }
      : { state: "invalid", sentence: MEETING_STATES.invalid };
  }
  return { state: "loading", sentence: MEETING_STATES.loading };
}

/* ---------------------------------------------------------- identity and owner */

const clock = (value) => formatClock(value) || "time unknown";

export function meetingHeader(payload) {
  if (!validMeetingPayload(payload)) return null;
  const m = payload.meeting;
  const ended = m.mode_state === "ended";
  const identity = m.native_identity || {};
  return {
    id: m.id,
    title: m.title,
    ended,
    modeWord: ended ? "Ended" : "Live · not recording",
    source: m.platform ? `${m.platform} meeting` : identity.source_system === APP_SOURCE_SYSTEM ? "started in DoctorCRE" : `from ${identity.source_system || "an unnamed source"}`,
    startedBy: m.started_by || "unknown",
    startedClock: clock(m.started_at),
    endedBy: m.ended_by || null,
    endedClock: m.ended_at ? clock(m.ended_at) : null,
    lastSeq: Number.isInteger(m.last_seq) ? m.last_seq : 0,
  };
}

/**
 * Who holds the one processing lease. Instances are per device, so "held here"
 * is decided by this device's instance, never by the actor alone: the same
 * partner on a second laptop is a participant, not a second owner.
 */
export function processingOwner(payload, instance) {
  const lease = validMeetingPayload(payload) ? payload.lease : null;
  if (!lease) return { state: "none", holder: null, holderInstance: null, epoch: null, sentence: "Nobody holds processing for this meeting." };
  const who = `${lease.holder} on ${lease.holder_instance}`;
  if (lease.released === true) return { state: "released", holder: lease.holder, holderInstance: lease.holder_instance, epoch: lease.lease_epoch, sentence: `Processing was released by ${who}.` };
  if (lease.live !== true) return { state: "expired", holder: lease.holder, holderInstance: lease.holder_instance, epoch: lease.lease_epoch, sentence: `Processing lapsed on ${who}; any partner's device may take it over.` };
  if (lease.holder_instance === instance) return { state: "held_here", holder: lease.holder, holderInstance: lease.holder_instance, epoch: lease.lease_epoch, sentence: `This device holds processing (lease ${lease.lease_epoch}).` };
  return { state: "held_by_other", holder: lease.holder, holderInstance: lease.holder_instance, epoch: lease.lease_epoch, sentence: `Processing is held by ${who}. This device is a participant: it sees the same notes and actions and starts no second worker.` };
}

/** Has THIS device started or joined the meeting? Read from the stream, never assumed. */
export function joinedHere(stream = [], instance) {
  return stream.some((entry) => (entry.kind === "meeting_started" || entry.kind === "meeting_joined") && entry.client_instance === instance);
}

/** A device renews only a lease it holds, and only while the meeting is live. */
export function shouldRenewLease(payload, instance) {
  const header = meetingHeader(payload);
  return Boolean(header && !header.ended && processingOwner(payload, instance).state === "held_here");
}

/* ------------------------------------------------------------------- the notes */

/** Notes grouped by number; the latest revision leads and every earlier one is kept. */
export function noteRows(payload) {
  if (!validMeetingPayload(payload)) return [];
  const byNumber = new Map();
  for (const note of payload.notes) {
    if (!Number.isInteger(note?.note_number) || !Number.isInteger(note?.revision)) continue;
    const list = byNumber.get(note.note_number) || [];
    list.push(note);
    byNumber.set(note.note_number, list);
  }
  return [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([number, revisions]) => {
    const ordered = [...revisions].sort((a, b) => b.revision - a.revision);
    const view = (n) => ({ revision: n.revision, body: String(n.body ?? ""), author: n.author || "unknown", instance: n.author_instance || "", clock: clock(n.at) });
    return { number, revision: ordered[0].revision, current: view(ordered[0]), history: ordered.slice(1).map(view) };
  });
}

/* ----------------------------------------------------------------- the actions */

/** The words each state is drawn with. Only executed and delegated say done. */
export const ACTION_STATE_WORDS = Object.freeze({
  needs_approval: "Proposed — waiting for a partner to confirm",
  tentative: "Proposed — tentative discussion, nothing to run",
  accepted: "Accepted — record effect not yet confirmed",
  executed: "Done — confirmed in the record",
  delegated: "Delegated — handoff confirmed in the record",
  declined: "Skipped — closed without action",
});

export function commandLabel(command) {
  if (!command || typeof command !== "object") return null;
  if (command.verb === "add-loop") {
    const a = command.args || {};
    return `Follow-up for ${a.owner || "unassigned"}: ${a.title || a.body || "untitled"}`;
  }
  return `Record change via ${command.verb}`;
}

function currentRevision(action) {
  const revisions = Array.isArray(action.revisions) ? action.revisions : [];
  return revisions.find((r) => r.revision === action.current_revision) ?? revisions.at(-1) ?? {};
}

/** The drawn state tag. `accepted` is never folded into done. */
export function actionTag(action) {
  if (action.state === "executed" && action.outcome) return "executed";
  if (action.state === "delegated" && action.outcome) return "delegated";
  if (action.state === "declined") return "declined";
  if (action.state === "proposed") return currentRevision(action).command || action.command ? "needs_approval" : "tentative";
  return "accepted";
}

export function actionRows(payload) {
  if (!validMeetingPayload(payload)) return [];
  const ended = payload.meeting.mode_state === "ended";
  return [...payload.actions].sort((a, b) => a.action_number - b.action_number).map((action) => {
    const current = currentRevision(action);
    const tag = actionTag(action);
    const dispatchVerb = action.dispatch?.verb || null;
    return {
      number: action.action_number,
      tag,
      stateWord: ACTION_STATE_WORDS[tag],
      summary: current.summary || "",
      basis: current.basis || null,
      source: current.source || null,
      command: current.command || null,
      commandLabel: commandLabel(current.command),
      revision: action.current_revision,
      proposedBy: current.proposed_by || "unknown",
      decidedBy: action.decided_by || null,
      assignee: action.assignee || null,
      disposition: action.disposition || null,
      dispatch: action.dispatch || null,
      outcome: action.outcome || null,
      history: (Array.isArray(action.revisions) ? action.revisions : [])
        .filter((r) => r.revision !== action.current_revision)
        .sort((a, b) => b.revision - a.revision)
        .map((r) => ({ revision: r.revision, summary: r.summary, by: r.proposed_by || "unknown", clock: clock(r.at) })),
      controls: {
        confirm: tag === "needs_approval",
        skip: tag === "needs_approval" || tag === "tentative",
        finish: tag === "accepted" && Boolean(action.dispatch),
        appCarriesVerb: dispatchVerb ? DISPATCHABLE_VERBS.includes(dispatchVerb) : false,
        revise: !ended && action.state === "proposed",
      },
    };
  });
}

/* ------------------------------------------------------------------ the stream */

const STREAM_WORDS = Object.freeze({
  meeting_started: "started the meeting",
  meeting_joined: "joined",
  processing_acquired: "took processing",
  processing_taken_over: "took over lapsed processing",
  processing_released: "released processing",
  note_added: "added note",
  note_revised: "revised note",
  action_proposed: "proposed action",
  action_revised: "revised action",
  action_accepted: "accepted action",
  action_declined: "skipped action",
  action_executed: "confirmed done: action",
  action_delegated: "confirmed delegated: action",
  meeting_ended: "ended the meeting",
});

/** Merge a page of the stream into what is held: by seq, once each, ascending. */
export function mergeStream(held = [], incoming = []) {
  const bySeq = new Map();
  for (const entry of [...held, ...incoming]) if (Number.isInteger(entry?.seq)) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The `after_seq` a reconnecting device resumes from: exclusive, so no entry repeats. */
export function streamCursor(stream = []) {
  return stream.reduce((high, entry) => (Number.isInteger(entry?.seq) && entry.seq > high ? entry.seq : high), 0);
}

export function streamRows(stream = []) {
  return stream.map((entry) => {
    const subject = entry.note_number ? ` ${entry.note_number}` : entry.action_number ? ` ${entry.action_number}` : "";
    const revision = entry.revision && entry.revision > 1 ? ` (revision ${entry.revision})` : "";
    return { seq: entry.seq, kind: entry.kind, sentence: `${entry.actor || "someone"} ${STREAM_WORDS[entry.kind] || entry.kind}${subject}${revision}`, clock: clock(entry.at) };
  });
}

/* ------------------------------------------------------------------- the recap */

export const RECAP_BUCKETS = Object.freeze([
  Object.freeze({ key: "done", title: "Done" }),
  Object.freeze({ key: "delegated", title: "Delegated" }),
  Object.freeze({ key: "needs_approval", title: "Needs approval" }),
  Object.freeze({ key: "unresolved", title: "Unresolved" }),
  Object.freeze({ key: "closed_without_action", title: "Skipped" }),
]);

/** The server's deterministic recap, printed; this page recomputes none of it. */
export function recapView(payload) {
  if (!validMeetingPayload(payload)) return null;
  const recap = payload.recap;
  const status = payload.status || {};
  return {
    buckets: RECAP_BUCKETS.map(({ key, title }) => ({
      key, title,
      count: Number.isInteger(recap.counts?.[key]) ? recap.counts[key] : (recap[key] || []).length,
      items: (recap[key] || []).map((item) => ({ number: item.action_number, summary: item.summary || "", assignee: item.assignee || null })),
    })),
    lines: [
      status.recording === "never_started" ? "Recording: never started." : "Recording: not reported.",
      status.processing_complete === true ? "Processing: finished." : "Processing: not finished.",
      status.review_complete === true ? "Review: every action is resolved." : "Review: some actions still need a partner or a confirmed record effect.",
    ],
  };
}

/* -------------------------------------------------------------- operation keys */

/**
 * One operation per intent per subject. A draft carries its own local id, so two
 * notes never share a key and a retry of one never replays the other.
 */
export const startOperationKey = (draftId) => `meeting:start:${draftId}`;
export const joinOperationKey = (id) => `meeting:join:${id}`;
export const processingOperationKey = (id) => `meeting:processing:${id}`;
export const releaseOperationKey = (id) => `meeting:release:${id}`;
export const noteOperationKey = (id, draftId) => `meeting:note:${id}:${draftId}`;
export const reviseNoteOperationKey = (id, number, base) => `meeting:note-revision:${id}:${number}:${base}`;
export const proposeOperationKey = (id, draftId) => `meeting:propose:${id}:${draftId}`;
export const decideOperationKey = (id, number) => `meeting:decide:${id}:${number}`;
export const reconcileOperationKey = (id, number) => `meeting:reconcile:${id}:${number}`;
export const dispatchOperationKey = (id, number) => `meeting:dispatch:${id}:${number}`;
export const endOperationKey = (id) => `meeting:end:${id}`;

/* ------------------------------------------------------------------ the writes */

const cleanLine = (value, max) => {
  const text = String(value ?? "").trim();
  return text && text.length <= max && !CONTROL.test(text) && !/[\n\r\t]/.test(text) ? text : null;
};
const cleanBlock = (value, max) => {
  const text = String(value ?? "");
  return text.trim() && text.length <= max && !CONTROL.test(text.replace(/[\n\t]/g, "")) ? text : null;
};
const guard = (built) => {
  if (!built.ok) return built;
  const paths = recordingFieldPaths(built.args);
  return paths.length ? { ok: false, message: `This page refuses to send ${paths.join(", ")}: Meeting Mode captures no audio.` } : built;
};

/**
 * A new ad-hoc meeting. The native id is minted HERE, once, by the caller's
 * newId; the kernel freezes it with the request, so a retry re-sends the same
 * identity and the store answers with the same meeting.
 */
export function startArgs({ title, instance, newId }) {
  const clean = cleanLine(title, 200);
  if (!clean) return { ok: false, message: TITLE_REFUSAL };
  return guard({ ok: true, args: {
    title: clean,
    native_identity: { source_system: APP_SOURCE_SYSTEM, native_id: `adhoc-${newId()}`, native_id_epoch: "1" },
    activation_intent: ACTIVATION_INTENT,
    client_instance: instance,
  } });
}

/** Joining is start-meeting with the identity this page READ, never one it made up. */
export function joinArgs(payload, instance) {
  if (!validMeetingPayload(payload)) return { ok: false, message: NOT_READ_REFUSAL };
  const m = payload.meeting;
  const args = {
    title: m.title,
    native_identity: {
      source_system: m.native_identity?.source_system,
      native_id: m.native_identity?.native_id,
      native_id_epoch: m.native_identity?.native_id_epoch,
    },
    activation_intent: ACTIVATION_INTENT,
    client_instance: instance,
  };
  if (m.platform) args.platform = m.platform;
  return guard({ ok: true, args });
}

export function claimArgs(meetingId, instance, { release = false } = {}) {
  if (!MEETING_ID.test(String(meetingId))) return { ok: false, message: NOT_READ_REFUSAL };
  const args = { meeting_id: meetingId, client_instance: instance };
  if (release) args.release = true;
  return guard({ ok: true, args });
}

export function noteArgs(payload, { body, instance, revises = null }) {
  if (!validMeetingPayload(payload)) return { ok: false, message: NOT_READ_REFUSAL };
  if (payload.meeting.mode_state === "ended") return { ok: false, message: ENDED_REFUSAL };
  const clean = cleanBlock(body, 20000);
  if (!clean) return { ok: false, message: NOTE_REFUSAL };
  const args = { meeting_id: payload.meeting.id, body: clean, client_instance: instance };
  if (revises !== null) {
    const row = noteRows(payload).find((note) => note.number === revises);
    if (!row) return { ok: false, message: REVISION_REFUSAL };
    // The base is the revision ON SCREEN. A conflict is re-read, never bumped.
    args.revises_note_number = row.number;
    args.base_revision = row.revision;
  }
  return guard({ ok: true, args });
}

/** The one canonical command this page composes: a follow-up task through add-loop. */
export function followUpCommand({ title, owner }) {
  const clean = cleanLine(title, 300);
  const partner = PARTNERS.find((p) => p.slug === owner || p.owner === owner);
  if (!clean || !partner) return null;
  return { verb: "add-loop", args: { kind: "team_loop", owner: partner.owner, title: clean } };
}

/**
 * A proposal or an instruction. `tentative_discussion` stays a proposal whatever
 * it carries; `explicit_instruction` with a command is the signed-in partner's
 * own authorization and the store accepts it at once.
 */
export function proposeArgs(payload, { summary, basis, command = null, instance, revises = null }) {
  if (!validMeetingPayload(payload)) return { ok: false, message: NOT_READ_REFUSAL };
  if (payload.meeting.mode_state === "ended") return { ok: false, message: ENDED_REFUSAL };
  const clean = cleanBlock(summary, 2000);
  if (!clean) return { ok: false, message: SUMMARY_REFUSAL };
  if (!["tentative_discussion", "explicit_instruction"].includes(basis)) return { ok: false, message: SUMMARY_REFUSAL };
  if (basis === "explicit_instruction" && !command) return { ok: false, message: INSTRUCTION_REFUSAL };
  const args = { meeting_id: payload.meeting.id, summary: clean, basis, client_instance: instance };
  if (command) args.command = { verb: command.verb, args: { ...command.args } };
  if (revises !== null) {
    const row = actionRows(payload).find((action) => action.number === revises);
    if (!row || !row.controls.revise) return { ok: false, message: REVISION_REFUSAL };
    args.revises_action_number = row.number;
    args.base_revision = row.revision;
  }
  return guard({ ok: true, args });
}

/** Confirm or Skip, at the revision on screen. Delegation names its assignee. */
export function decideArgs(payload, number, decision, instance, { assignee = null } = {}) {
  const row = actionRows(payload).find((action) => action.number === number);
  if (!row) return { ok: false, message: NOT_READ_REFUSAL };
  const args = {
    meeting_id: payload.meeting.id, action_number: row.number,
    decision: decision === "accept" ? "accept" : "decline",
    base_revision: row.revision, client_instance: instance,
  };
  if (args.decision === "accept" && assignee) {
    const partner = PARTNERS.find((p) => p.slug === assignee);
    if (!partner) return { ok: false, message: FOLLOW_UP_REFUSAL };
    args.disposition = "delegate";
    args.assignee_slug = partner.slug;
  }
  return guard({ ok: true, args });
}

export function outcomeArgs(meetingId, number, instance) {
  if (!MEETING_ID.test(String(meetingId)) || !Number.isInteger(number)) return { ok: false, message: NOT_READ_REFUSAL };
  return guard({ ok: true, args: { meeting_id: meetingId, action_number: number, client_instance: instance } });
}

export function endArgs(meetingId, instance) {
  if (!MEETING_ID.test(String(meetingId))) return { ok: false, message: NOT_READ_REFUSAL };
  return guard({ ok: true, args: { meeting_id: meetingId, client_instance: instance } });
}

/* ------------------------------------------------- finishing an accepted action */

/**
 * Finish one accepted action: RECONCILE FIRST, dispatch only on `not_observed`,
 * and reconcile again. Both steps are injected kernel sends, so a double click
 * is a single flight and an unanswered step stays retained for its own retry.
 *
 *   reconcile() -> performCommand result for record-meeting-action-outcome
 *   dispatch(retry) -> performCommand result for the canonical verb, sent with
 *                      retry.idempotency_key, the key the STORE minted
 *
 * The answer names the stage it stopped at. `dispatch_unknown` deliberately
 * stops: the next attempt starts by reconciling, which is what tells a lost
 * answer from a write that never happened.
 */
export async function finishAcceptedAction({ reconcile, dispatch }) {
  const first = await reconcile();
  if (first.status !== "ok") return { stage: "reconcile", result: first };
  if (first.response?.reconciled === true) return { stage: "reconciled", outcome: first.response.outcome_state, result: first };
  const retry = first.response?.retry;
  if (!retry || !MEETING_ID.test(String(retry.idempotency_key))) return { stage: "reconcile", result: first };
  if (!DISPATCHABLE_VERBS.includes(retry.verb)) return { stage: "not_dispatchable", verb: retry.verb, result: first };
  const sent = await dispatch(retry);
  if (sent.status === "unknown") return { stage: "dispatch_unknown", result: sent };
  if (sent.status !== "ok") return { stage: "dispatch_refused", result: sent };
  const second = await reconcile();
  if (second.status !== "ok") return { stage: "reconcile", result: second };
  if (second.response?.reconciled === true) return { stage: "reconciled", outcome: second.response.outcome_state, result: second };
  return { stage: "not_observed", result: second };
}

/** What a finish attempt says to a person. */
export function finishSentence(finish, number) {
  switch (finish.stage) {
    case "reconciled": return `Action ${number} is ${finish.outcome === "delegated" ? "delegated" : "done"} — the record confirms it.`;
    case "not_dispatchable": return `Action ${number} was accepted, but this app does not make ${finish.verb}. It stays unresolved until that change is made and confirmed elsewhere.`;
    case "dispatch_unknown": return `Action ${number}'s change was sent and no answer came back. Use Check outcome: it asks the record first and re-sends only under the same key.`;
    case "dispatch_refused": return `Action ${number}'s change was refused by the record layer. It stays accepted and unresolved.`;
    case "not_observed": return `Action ${number}'s change was answered, but the record does not show it yet. Check outcome again shortly.`;
    default: return `Action ${number}'s outcome could not be confirmed. Nothing was re-sent; use Check outcome.`;
  }
}
