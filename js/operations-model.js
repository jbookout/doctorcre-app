// V5-UX-C14 — the Control Room's Operations cards, decided without a DOM.
//
// Two cards, held to the same rules as the rest of ./control-room-model.js:
//
//   1. Approvals come from ONE read, `governance-queue` (mcp-server/src/tools.js
//      over ops.read_governance_queue(), migration 0345), in the producer's own
//      lane and field names. An unanswered or malformed read is `unknown`, never
//      0; an answered empty queue is a real 0.
//   2. The card says what it is NOT. governance-queue lists rules awaiting
//      approve-rule, guidance import batches awaiting
//      decide-guidance-import-batch and retrieval proposals awaiting
//      approve-retrieval-proposals. It does not list approvals of production
//      effects, and no read does, so none is claimed.
//   3. Scheduled automation has NO read at all: no CARR verb reads scheduled
//      jobs, launchd agents or routine state. That card is a named no-read
//      state with no number and no countdown, because a countdown with no next
//      run behind it would be the page inventing one.
//   4. Motion is driven by the data that landed and nothing else: the count
//      climbs to the verified total, and the only ambient clock is the real age
//      of the oldest waiting decision. Reduced motion lands every value in one
//      frame and drops the ticking seconds.
import { STUCK_SILENCE_HOURS } from "./control-room-model.js";

const isText = (value) => typeof value === "string" && value.length > 0;
const isTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const orNull = (value, check) => value === null || value === undefined || check(value);

/** The three lanes, in the order the producer returns them, each with the verb that decides it. */
export const GOVERNANCE_LANES = Object.freeze([
  { id: "pending_rule_approvals", label: "Taught rules awaiting approval", verb: "approve-rule", idField: "rule_id", sinceField: "admitted_at" },
  { id: "pending_guidance_import_batches", label: "Guidance import batches awaiting a decision", verb: "decide-guidance-import-batch", idField: "batch_id", sinceField: "staged_at" },
  { id: "pending_retrieval_proposals", label: "Retrieval proposals awaiting approval", verb: "approve-retrieval-proposals", idField: "proposal_id", sinceField: "proposed_at" },
]);

export const APPROVALS_OUT_OF_SCOPE = "Approvals of production effects are not in this card. Their verbs (accept-ready-plan, accept-workflow, issue-execution-envelope) are partner-only and hash-pinned, and no read lists what is pending, so none is claimed here.";

const APPROVALS_AUTHORITY = "Read-only. This card grants no authority: each decision is taken with its own partner verb in the record layer, never from this page.";

// Kept verbatim from the placeholder it replaces: a statement about behaviour
// already true of every command on this app (CR-AC-22, C23), not a promise.
const RECONCILE_RULE = "Reconcile before retry is already how every command on this app behaves: an unknown outcome is re-checked under its own key before anything is sent again.";

/** `governance-queue`'s own shape: three lanes and counts that agree with them. */
export function validGovernanceQueuePayload(payload) {
  if (!payload || typeof payload !== "object" || payload.ok !== true) return false;
  const counts = payload.counts;
  if (!counts || typeof counts !== "object") return false;
  let total = 0;
  for (const lane of GOVERNANCE_LANES) {
    const rows = payload[lane.id];
    if (!Array.isArray(rows) || counts[lane.id] !== rows.length) return false;
    total += rows.length;
    if (!rows.every((row) => row && typeof row === "object"
      && isText(row[lane.idField]) && orNull(row[lane.sinceField], isTime))) return false;
  }
  return Number.isInteger(counts.total) && counts.total === total;
}

const detailRow = (label, value) => (isText(value) ? { label, value } : null);

/** One waiting decision, carrying only what the read said. */
function laneItem(lane, row) {
  let title;
  let detail;
  if (lane.id === "pending_rule_approvals") {
    title = isText(row.statement) ? row.statement : "rule (no statement recorded)";
    detail = [
      detailRow("partner words", row.human_quote),
      detailRow("enforcement", row.enforcement_class),
      detailRow("binding moment", row.binding_moment),
      detailRow("admission reason", row.admission_reason),
      detailRow("scope", row.scope),
    ];
  } else if (lane.id === "pending_guidance_import_batches") {
    title = isText(row.reason) ? row.reason
      : isText(row.staging_key) ? `import batch ${row.staging_key} (no reason recorded)` : "import batch (no reason recorded)";
    detail = [
      detailRow("staging key", row.staging_key),
      detailRow("entries", Number.isInteger(row.entry_count) ? String(row.entry_count) : null),
      detailRow("manifest", row.manifest_digest),
    ];
  } else {
    title = isText(row.reason) ? row.reason : `${row.proposal_type || "retrieval"} proposal (no reason recorded)`;
    detail = [
      detailRow("type", row.proposal_type),
      detailRow("proposed by", row.proposer_actor_id),
      detailRow("version", Number.isInteger(row.version) ? String(row.version) : null),
    ];
  }
  return { key: row[lane.idField], title, since: isTime(row[lane.sinceField]) ? row[lane.sinceField] : null, detail: detail.filter(Boolean) };
}

/**
 * The approvals card. `read` is {state: "read", payload} or {state: "unknown", reason}.
 * @returns {{id:string, title:string, state:"read"|"unknown", value:number|null, word:string,
 *   sentence:string, lanes:Object[], oldest:{at:string, lane:string, key:string}|null,
 *   scope:string, authority:string, rule:string}}
 */
export function approvalsCard(read) {
  const base = {
    id: "approvals", title: "Approvals waiting on a partner",
    scope: APPROVALS_OUT_OF_SCOPE, authority: APPROVALS_AUTHORITY, rule: RECONCILE_RULE,
  };
  if (read?.state !== "read" || !validGovernanceQueuePayload(read.payload)) {
    const reason = read?.state === "read"
      ? "the governance queue answered in a shape this page does not recognise"
      : read?.reason || "the governance queue did not answer";
    return { ...base, state: "unknown", value: null, word: "unknown", sentence: `This is unknown: ${reason}.`, lanes: [], oldest: null };
  }
  const payload = read.payload;
  const lanes = GOVERNANCE_LANES.map((lane) => ({
    id: lane.id, label: lane.label, verb: lane.verb, count: payload[lane.id].length,
    items: payload[lane.id].map((row) => laneItem(lane, row)),
  }));
  let oldest = null;
  for (const lane of lanes) {
    for (const item of lane.items) {
      if (item.since && (!oldest || Date.parse(item.since) < Date.parse(oldest.at))) {
        oldest = { at: item.since, lane: lane.id, key: item.key };
      }
    }
  }
  const total = payload.counts.total;
  return {
    ...base, state: "read", value: total, word: String(total),
    sentence: total === 0
      ? "Nothing is waiting on a partner's governance decision."
      : total === 1 ? "One governance decision is waiting on a partner." : `${total} governance decisions are waiting on a partner.`,
    lanes, oldest,
  };
}

/**
 * How long the oldest decision has waited, as words (never a clock face), and
 * the tempo its ambient pulse breathes at. Urgent starts at the approved
 * silence cadence the Stuck tile already uses, so no second threshold is made
 * up here.
 */
export function waitingAge(sinceIso, now = Date.now(), { seconds = true } = {}) {
  const since = typeof sinceIso === "string" ? Date.parse(sinceIso) : NaN;
  if (!Number.isFinite(since) || !Number.isFinite(now)) return { known: false, ms: null, text: "unknown", tempo: null };
  const ms = Math.max(0, now - since);
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  const hours = ms / 3_600_000;
  const tempo = hours >= STUCK_SILENCE_HOURS ? "urgent" : hours >= 24 ? "attention" : "calm";
  return { known: true, ms, text: seconds ? `waiting ${d}d ${h}h ${m}m ${s}s` : `waiting ${d}d ${h}h ${m}m`, tempo };
}

/**
 * Scheduled automation: a named no-read state. No CARR verb reads a schedule,
 * a last run or a next run, so the card carries no number and no countdown.
 * When a schedule read exists, `countdown` is where the next run's time goes.
 */
export function scheduleCard() {
  return {
    id: "automation",
    title: "Scheduled automation",
    state: "no_read",
    word: "no schedule read yet",
    body: "No schedule read yet. No CARR verb reads scheduled jobs, launchd agents or routine state, so last run, next run and active state are not shown, and disable-legacy-schedule is a partner-only write, not a read. This card will count down to the next run when a schedule read exists.",
    countdown: null,
    slice: "V5-UX-C14",
  };
}

/* ------------------------------------------------------------------ motion */

export const ENTRANCE_STEP_MS = 60;
export const ENTRANCE_MAX_STEPS = 8;

/** The stagger for the Nth entering element, capped so a long list never delays its tail. */
export function entranceDelay(index) {
  const step = Number.isInteger(index) && index > 0 ? Math.min(index, ENTRANCE_MAX_STEPS) : 0;
  return step * ENTRANCE_STEP_MS;
}

/** Integer frames from one verified value to the next, landing exactly on it. */
export function countUpFrames(from, to, { reduced = false, steps = 12 } = {}) {
  if (reduced || !Number.isFinite(from) || !Number.isFinite(to) || from === to) return [to];
  const frames = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const eased = 1 - (1 - t) ** 3;
    frames.push(i === steps ? to : Math.round(from + (to - from) * eased));
  }
  return frames;
}

/** Either the operating-system setting or the app's own motion preference turns motion off. */
export function prefersReducedMotion(env = globalThis) {
  try {
    if (env?.document?.documentElement?.dataset?.motion === "reduced") return true;
    return env?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}
