// V5-UX-C15 — what the independent status page says, decided without a DOM.
//
// This page exists for the one case the Control Room cannot cover: the Control
// Room is a gated page, so a CARR outage takes it with it (CR-AC-26). /status
// is served by the app's own Worker ahead of the gate, so it can still answer
// when the record layer cannot.
//
// Three rules hold this file together:
//
//   1. The record layer's own error text NEVER reaches the page. A refusal is
//      mapped to one fixed app sentence, because CARR's /health reason leaks a
//      runbook path and the page must not leak operational detail (CR-AC-26).
//   2. unknown is never a count and never a zero. A read that did not answer
//      makes only its own chip unknown (CR-AC-02), and the others are untouched.
//   3. The last-known snapshot carries no payload rows — no titles, no refs, no
//      counts. It is a dimmed, timestamped picture of which reads answered
//      (C21), never a value a tile may use.
import { READS, READ_LABEL, coverageLine } from "./control-room-model.js";
import { formatClock } from "./visual-system.js";

/** The one sentence any refusal becomes, whatever the server said. */
export const REFUSAL_SENTENCE = "the record layer refused or timed out";

/** The app's own read of itself, stated alongside the four record-layer reads. */
export const APP_READ_ID = "app";
export const APP_READ_LABEL = "app";
export const APP_REFUSAL_SENTENCE = "the app did not answer";

export const SNAPSHOT_KEY = "doctorcre.status-snapshot.v1";
export const SNAPSHOT_SCHEMA = "doctorcre-status-snapshot.v1";

/** The only keys a stored read may carry. Anything else is a payload leak. */
export const SNAPSHOT_READ_KEYS = Object.freeze(["id", "state", "observed_at", "reason", "coverage_word"]);

/**
 * Titles, not descriptions. Each row is the literal word unknown with the
 * reason it is unknown: there is no producer, and simulating one would be the
 * fabrication this whole surface exists to prevent.
 */
export const INTEGRATION_GAPS = Object.freeze([
  Object.freeze({ id: "v5-a01", title: "Truthful health and scoped degradation (V5-A01)", word: "unknown", reason: "no producer yet" }),
  Object.freeze({ id: "v5-f08", title: "Backup, restore and degraded-operation posture (V5-F08)", word: "unknown", reason: "no producer yet" }),
  Object.freeze({ id: "v5-f07", title: "Supervisor and job health (V5-F07)", word: "unknown", reason: "no producer yet" }),
]);

/** Anchors only. The page never fetches these: CSP connect-src is 'self'. */
export const PROVIDER_LINKS = Object.freeze([
  Object.freeze({ id: "cloudflare", label: "Cloudflare status", href: "https://www.cloudflarestatus.com/" }),
  Object.freeze({ id: "neon", label: "Neon status", href: "https://neonstatus.com/" }),
  Object.freeze({ id: "github", label: "GitHub status", href: "https://www.githubstatus.com/" }),
]);

const ACTION_RETRY = "Retry in a minute; if it persists, open the incident queue when the record layer returns.";
const ACTION_PROVIDERS = "Check the provider status pages below.";

const answered = (read) => read?.state === "read";

/**
 * Strip the server's words off every read before anything renders it. A read
 * that answered keeps its clock; a read that did not carries the app's own
 * fixed sentence and nothing the record layer wrote.
 */
export function sanitizeReads(reads) {
  const source = reads && typeof reads === "object" ? reads : {};
  const out = {};
  for (const id of READS) {
    const read = source[id];
    if (!read) continue;
    out[id] = answered(read)
      ? { state: "read", observed_at: read.observed_at }
      : { state: "unknown", reason: REFUSAL_SENTENCE };
  }
  return out;
}

/** The app's own chip, in the same shape `coverageLine` produces. */
export function appChip(release) {
  const clock = answered(release) ? formatClock(release.observed_at) : null;
  if (clock) return { id: APP_READ_ID, name: APP_READ_LABEL, state: "read", text: `${APP_READ_LABEL}: read at ${clock}` };
  const reason = answered(release) ? "the read carried no readable time" : APP_REFUSAL_SENTENCE;
  return { id: APP_READ_ID, name: APP_READ_LABEL, state: "unknown", reason, text: `${APP_READ_LABEL}: unknown (${reason})` };
}

/** The four record-layer chips plus the app chip, each stating its own clock. */
export function statusChips({ release, reads }) {
  return [appChip(release), ...coverageLine(sanitizeReads(reads))];
}

/**
 * Exactly four scenarios. Which one is true is decided by two facts only:
 * whether the app answered about itself, and whether every record-layer read
 * answered. A stored snapshot changes what scenario 3 can show; it never
 * changes whether the app is serving.
 *
 * @param {{release: object, reads: object, snapshot: object|null}} input
 */
export function statusHeadline({ release, reads, snapshot = null } = {}) {
  const clean = sanitizeReads(reads);
  const attempted = READS.filter((id) => clean[id]);
  const silent = attempted.filter((id) => clean[id].state !== "read");

  if (answered(release)) {
    if (silent.length === 0) {
      return {
        scenario: 1,
        headline: "DoctorCRE is serving and the record layer answered.",
        action: "Nothing to do.",
        silent: [],
        lastKnown: false,
      };
    }
    return {
      scenario: 2,
      headline: `DoctorCRE is serving; the record layer did not answer for: ${silent.map((id) => READ_LABEL[id]).join(", ")}.`,
      action: ACTION_RETRY,
      silent,
      lastKnown: false,
    };
  }

  const savedAt = formatClock(snapshot?.saved_at) ? snapshot.saved_at : null;
  if (savedAt) {
    return {
      scenario: 3,
      headline: "The DoctorCRE app itself did not answer.",
      action: ACTION_PROVIDERS,
      silent: attempted,
      lastKnown: true,
      lastKnownTitle: "Last known",
      lastKnownAsOf: `as of ${formatClock(savedAt)}`,
      saved_at: savedAt,
    };
  }
  return {
    scenario: 4,
    headline: "The DoctorCRE app itself did not answer.",
    action: ACTION_PROVIDERS,
    silent: attempted,
    lastKnown: false,
    emptyChipText: "unknown (no answer and nothing stored on this device)",
  };
}

/**
 * The stored picture: which reads answered and when, and nothing else. No
 * titles, no refs, no counts of operational items — a device cache of business
 * rows is exactly the stale-looks-live failure the service worker already
 * refuses for /api/, and this file will not reintroduce it.
 */
export function snapshotFromReads(reads, now) {
  const source = reads && typeof reads === "object" ? reads : {};
  const ids = [APP_READ_ID, ...READS].filter((id) => source[id]);
  return {
    schema: SNAPSHOT_SCHEMA,
    saved_at: new Date(now || Date.now()).toISOString(),
    reads: ids.map((id) => {
      const read = source[id] || {};
      const ok = answered(read);
      return {
        id,
        state: ok ? "read" : "unknown",
        observed_at: ok && typeof read.observed_at === "string" ? read.observed_at : null,
        reason: ok ? null : (id === APP_READ_ID ? APP_REFUSAL_SENTENCE : REFUSAL_SENTENCE),
        coverage_word: ok ? "read" : "unknown",
      };
    }),
  };
}

/** Never throws, never returns a half-read shape: a bad store is simply absent. */
export function readSnapshot(storage) {
  try {
    const raw = storage?.getItem?.(SNAPSHOT_KEY);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.schema !== SNAPSHOT_SCHEMA) return null;
    if (typeof parsed.saved_at !== "string" || !formatClock(parsed.saved_at)) return null;
    if (!Array.isArray(parsed.reads)) return null;
    const reads = parsed.reads
      .filter((row) => row && typeof row === "object" && typeof row.id === "string")
      .map((row) => Object.fromEntries(SNAPSHOT_READ_KEYS.map((key) => [key, row[key] ?? null])));
    return { schema: parsed.schema, saved_at: parsed.saved_at, reads };
  } catch {
    return null;
  }
}

/** Returns whether the write landed; a refusing store is not an error here. */
export function writeSnapshot(storage, snapshot) {
  try {
    storage?.setItem?.(SNAPSHOT_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}
