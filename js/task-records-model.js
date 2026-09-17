// V5-UX-B02 — Task records, handover and Quick add: every decision, none of the
// wiring. No DOM, no fetch, no clock except the `now` a caller injects.
//
// The record layer owns the vocabulary and this file never invents one. A task
// is a loop record: `open_loop` is personal and carries a blocker; `team_loop`
// is shared and refuses one. Ownership is a label — joe or dell — and a
// handover is a change of that label, never a second record. Nothing here
// writes, and nothing here guesses an identity: every argument set is built
// from a loop the caller has just re-read, and carries that read's own version.

import { formatDueStamp, orderWork } from "./visual-system.js";

/** The two kinds this surface shows. Ideas and action-required items are elsewhere. */
export const TASK_KINDS = Object.freeze(["open_loop", "team_loop"]);

/** The only owners a person may choose here. Claude is never offered. */
export const PARTNERS = Object.freeze(["joe", "dell"]);

const KIND_SET = new Set(TASK_KINDS);
const PARTNER_SET = new Set(PARTNERS);
const RESOLUTIONS = new Set(["done", "dropped"]);

/** "joe" reads as Joe wherever a person sees it. */
export function partnerName(slug) {
  const value = String(slug || "").toLowerCase();
  if (value === "joe") return "Joe";
  if (value === "dell") return "Dell";
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

/* ------------------------------------------------------------------ the board read */

/**
 * The loop-board row, key by key. A row is rejected when a key the surface
 * depends on is missing — a row with no version cannot be written against, and
 * showing it would offer a handover this page could not honestly send.
 */
const ROW_REQUIRED = Object.freeze(["number", "kind", "status", "owner", "marker", "title", "version"]);
const ROW_OPTIONAL = Object.freeze(["domain", "label", "joint_owner", "blocker_class", "blocker_detail", "since_text", "due_on"]);

/** Every key this surface reads off a board row, and nothing else. */
export const BOARD_ROW_KEYS = Object.freeze([...ROW_REQUIRED, ...ROW_OPTIONAL]);

export function validBoardPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (!Array.isArray(payload.loops)) return false;
  return Number.isInteger(payload.count) && payload.count >= 0;
}

/**
 * One row, reduced to the keys this page reads. An extra key a future server
 * adds is dropped rather than carried: a surface that re-sends what it does not
 * understand is a surface that writes what it did not mean.
 */
export function normalizeBoardRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  for (const key of ROW_REQUIRED) {
    const value = row[key];
    if (value === undefined || value === null || value === "") return null;
  }
  if (!KIND_SET.has(row.kind)) return null;
  const normalized = {
    number: String(row.number),
    kind: row.kind,
    status: String(row.status),
    owner: String(row.owner).toLowerCase(),
    marker: String(row.marker),
    title: String(row.title),
    version: row.version,
    domain: row.domain ?? null,
    label: row.label ?? null,
    joint_owner: row.joint_owner === true,
    blocker_class: row.blocker_class ?? null,
    blocker_detail: row.blocker_detail ?? null,
    since_text: row.since_text ?? null,
    due_on: row.due_on ?? null,
  };
  return Object.freeze(normalized);
}

/**
 * Who a scope shows. "Team" is the partnership's open work, and the rows owned
 * by the system, or jointly, go to their own collapsed group rather than being
 * dropped: a record the board holds and this page hides is a record nobody
 * reads. "Mine" is the viewer's own rows and nothing else.
 */
export function scopeRows(rows, { scope = "team", viewer = "joe" } = {}) {
  const open = (rows || []).filter((row) => row && KIND_SET.has(row.kind) && row.status === "open");
  const system = open.filter((row) => row.joint_owner === true || !PARTNER_SET.has(row.owner));
  const partnered = open.filter((row) => row.joint_owner !== true && PARTNER_SET.has(row.owner));
  if (scope === "mine") {
    return { visible: partnered.filter((row) => row.owner === String(viewer).toLowerCase()), systemOwned: [] };
  }
  return { visible: partnered, systemOwned: system };
}

/**
 * The shared ordering: pinned first, then overdue, deadline, blocked, ordinary.
 * A human_only blocker is not a block for this purpose — it is the person's own
 * task, which is exactly the thing that should not sink below a vendor's delay.
 */
export function orderTaskRows(rows, now) {
  return orderWork((rows || []).map((row) => ({
    ...row,
    due: row.due_on || null,
    blocked: Boolean(row.blocker_class) && row.blocker_class !== "human_only",
    blockedOn: row.blocker_detail || null,
    pinned: row.marker === "bell",
  })), now);
}

/* ------------------------------------------------------------------ handover */

/** The partner a row would move to, or null when the owner is not a partner. */
export function handoverTarget(row, viewer = null) {
  const owner = String(row?.owner || "").toLowerCase();
  if (!PARTNER_SET.has(owner)) return null;
  const other = PARTNERS.find((slug) => slug !== owner);
  return other || (PARTNER_SET.has(String(viewer || "").toLowerCase()) ? String(viewer).toLowerCase() : null);
}

function writeBase(loop) {
  if (!loop || typeof loop !== "object") throw new TypeError("a write needs the loop that was just read");
  if (!loop.loop_id) throw new TypeError("a write needs the loop_id from a fresh read");
  if (loop.version === undefined || loop.version === null) throw new TypeError("a write needs the base_version from a fresh read");
  return { loop_id: loop.loop_id, base_version: loop.version };
}

/**
 * A handover is one field. Both kinds take the same shape, and neither carries
 * a blocker: an open_loop already has one and re-sending it would restate a
 * reason nobody re-read, and a team_loop refuses one outright.
 */
export function handoverArgs(loop, to) {
  const target = String(to || "").toLowerCase();
  if (!PARTNER_SET.has(target)) throw new TypeError(`${to} is not a partner this surface may hand work to`);
  return { ...writeBase(loop), owner: target };
}

/** Completing or dropping. The outcome is the person's sentence, never a default. */
export function closeArgs(loop, { resolution = "done", outcome = "" } = {}) {
  const text = String(outcome || "").trim();
  if (!text) throw new TypeError("closing a record needs an outcome in the person's own words");
  if (!RESOLUTIONS.has(resolution)) throw new TypeError(`${resolution} is not a resolution`);
  return { ...writeBase(loop), outcome: text, resolution };
}

/** A due date is the dated marker plus the day; the calendar supplies the day. */
export function dueDateArgs(loop, isoDate) {
  const day = String(isoDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError("a due date is a calendar day the picker produced");
  return { ...writeBase(loop), marker: "dated", due_on: day };
}

/* ------------------------------------------------------------------ Quick add */

/**
 * One sentence becomes one record.
 *
 * A task the viewer keeps is an `open_loop`, and the record layer requires a
 * named blocker on that kind. The honest one is `human_only`: the reason it is
 * still open is that a person has to do it. The detail says so in words, which
 * is also what keeps it clear of the server's vague-detail refusal.
 *
 * A task the sentence gives to the OTHER partner is not a personal loop at all
 * — it is shared work, so it files as a `team_loop`, owned by that partner,
 * with the original sentence kept as the body. No third owner is ever offered.
 */
export function quickAddPlan(parsed, { viewer = "joe", sentence = "" } = {}) {
  const questions = [...(parsed?.questions || [])];
  const action = parsed?.action || null;
  if (!action) {
    return Object.freeze({
      kind: null, args: null, summary: "",
      questions: questions.length ? questions : ["What is the action?"],
    });
  }
  const self = String(viewer || "joe").toLowerCase();
  const owner = String(parsed.owner || self).toLowerCase();
  const body = String(sentence || "").trim() || action;
  const dated = Boolean(parsed.due);
  const shared = PARTNER_SET.has(owner) && owner !== self;
  const common = {
    owner,
    title: action,
    body,
    domain: "business",
    marker: dated ? "dated" : "none",
    ...(dated ? { due_on: parsed.due } : {}),
  };
  const kind = shared ? "team_loop" : "open_loop";
  const args = shared
    ? { kind, ...common }
    : {
      kind, ...common,
      blocker: "human_only",
      blocker_detail: `${partnerName(owner)} does this personally: ${action}${parsed.related ? ` about ${parsed.related}` : ""}`,
    };
  const due = formatDueStamp(parsed.due, parsed.dueTime);
  const summary = shared
    ? `Hand “${action}” to ${partnerName(owner)}${due ? ` · ${due}` : ""}`
    : `Capture “${action}”${due ? ` · ${due}` : ""}`;
  return Object.freeze({ kind, args, summary, questions: [] });
}

/* ------------------------------------------------------------------ the popup */

const KIND_WORDS = Object.freeze({
  open_loop: "Your task",
  open_loop_other: "Personal task",
  team_loop_self: "Handed to you",
  team_loop_other: "Handed to",
});

/** How a record describes itself in the popup, in words rather than a slug. */
export function taskKindWords(loop, viewer = null) {
  const owner = String(loop?.owner || "").toLowerCase();
  const self = String(viewer || "").toLowerCase();
  if (loop?.kind === "team_loop") {
    return owner && owner === self ? KIND_WORDS.team_loop_self : `${KIND_WORDS.team_loop_other} ${partnerName(owner)}`.trim();
  }
  if (owner && owner === self) return KIND_WORDS.open_loop;
  return owner ? `${KIND_WORDS.open_loop_other} · ${partnerName(owner)}` : KIND_WORDS.open_loop_other;
}

/**
 * The popup's rows. A waiting line appears only when something OTHER than the
 * person is holding the record: "Joe does this personally" beside a task Joe
 * opened is noise, not information.
 */
export function taskDetailRows(loop, viewer = null) {
  const rows = [
    ["Record kind", taskKindWords(loop, viewer)],
    ["Owner", partnerName(loop?.owner)],
    ["Due", loop?.due_on ? formatDueStamp(loop.due_on) : "no date recorded"],
    ["Status", loop?.status === "open" ? "Open" : partnerName(loop?.status)],
  ];
  if (loop?.blocker_detail && loop?.blocker_class && loop.blocker_class !== "human_only") {
    rows.push(["Waiting on", loop.blocker_detail]);
  }
  rows.push(["Since", loop?.since_text || "not recorded"]);
  rows.push(["Number", String(loop?.number ?? "not recorded")]);
  return rows;
}

/**
 * What a refusal that arrives IN the payload says to a person. An ambiguous
 * number is never guessed at: two records really do share it, and only the
 * record layer can settle which one this is.
 */
export function loopRefusalMessage(payloadError, { number = null } = {}) {
  switch (payloadError) {
    case "not_found":
      return "That record is no longer on the board. Reload the list and open it from what the board holds now.";
    case "ambiguous_number":
      return `Two open records share number ${number ?? "that"}; open the record layer to renumber.`;
    case "need_number_or_id":
      return "That row arrived without a number, so the record could not be re-read. Reload the list.";
    default:
      return "The record could not be read, so nothing was sent.";
  }
}

/* ------------------------------------------------------------------ operation keys */

/**
 * A short, stable hash. It names the ONE logical operation a sentence stands
 * for, so a double-clicked Save is one command and not two records.
 */
export function stableKey(text) {
  let hash = 0x811c9dc5;
  const value = String(text ?? "");
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export const operationKeys = Object.freeze({
  handover: (row) => `handover:${row?.kind}:${row?.number}`,
  close: (row) => `close:${row?.kind}:${row?.number}`,
  due: (row) => `due:${row?.kind}:${row?.number}`,
  quickAdd: (sentence, viewer) => `quickadd:${stableKey(`${String(sentence || "").trim()}|${String(viewer || "")}`)}`,
});
