// V5-UX-B11 — what one device keeps about one meeting between page loads.
//
// Two things, both this device's and neither a record:
//
//   drafts   — the note and action text a partner is typing, with the local id
//              that names its operation. A reload, a lost connection or a
//              refused save gives the words back instead of losing them.
//   commands — the command kernel's entries that never got an answer. A reload
//              restores them so "Check outcome" re-sends the SAME frozen
//              request under the SAME key; minting a new one after a lost answer
//              is exactly the duplicate this slice exists to prevent. An entry
//              that was in flight when the page died is restored as unknown.
//
// Settled entries are never kept: the record layer holds what happened.
const PREFIX = "doctorcre:meeting:v1:";

const EMPTY_DRAFTS = Object.freeze({ title: "", titleId: null, note: "", noteId: null, action: "", actionId: null, followUp: "", owner: "" });

export function createMeetingMemory({ storage, scope, newId }) {
  const key = `${PREFIX}${encodeURIComponent(String(scope || "start"))}`;
  let persisted = Boolean(storage);
  let state = { drafts: { ...EMPTY_DRAFTS }, commands: {} };
  try {
    const raw = storage?.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      const drafts = parsed?.drafts && typeof parsed.drafts === "object" ? parsed.drafts : {};
      state.drafts = Object.fromEntries(Object.keys(EMPTY_DRAFTS).map((k) => [k, typeof drafts[k] === "string" ? drafts[k] : EMPTY_DRAFTS[k]]));
      const commands = parsed?.commands && typeof parsed.commands === "object" ? parsed.commands : {};
      state.commands = Object.fromEntries(Object.entries(commands)
        .filter(([, entry]) => entry && typeof entry.request?.idempotency_key === "string")
        .map(([op, entry]) => [op, { ...entry, status: "unknown", reason: "no_answer" }]));
    }
  } catch {
    persisted = false;
  }
  if (!state.drafts.titleId) state.drafts.titleId = newId();
  if (!state.drafts.noteId) state.drafts.noteId = newId();
  if (!state.drafts.actionId) state.drafts.actionId = newId();

  function persist() {
    try {
      if (!storage) throw new Error("storage unavailable");
      const commands = Object.fromEntries(Object.entries(state.commands)
        .filter(([, entry]) => entry.status === "unknown" || entry.status === "pending"));
      const empty = Object.keys(commands).length === 0 && !state.drafts.title && !state.drafts.note && !state.drafts.action && !state.drafts.followUp;
      if (empty) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify({ drafts: state.drafts, commands }));
      persisted = true;
    } catch {
      persisted = false;
    }
  }

  return {
    isPersisted: () => persisted,
    drafts: () => ({ ...state.drafts }),
    setDraft(patch) {
      state.drafts = { ...state.drafts, ...patch };
      persist();
    },
    /** A draft whose write was CONFIRMED is cleared and given a fresh operation id. */
    clearDraft(kind) {
      if (kind === "title") state.drafts = { ...state.drafts, title: "", titleId: newId() };
      if (kind === "note") state.drafts = { ...state.drafts, note: "", noteId: newId() };
      if (kind === "action") state.drafts = { ...state.drafts, action: "", actionId: newId(), followUp: "", owner: "" };
      persist();
    },
    commands: () => state.commands,
    setCommands(next) {
      state.commands = next || {};
      persist();
    },
  };
}

export function browserMeetingStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}
