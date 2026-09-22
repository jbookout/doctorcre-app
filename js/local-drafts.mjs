// Quick-add drafts belong to this browser and viewer. They are never requests
// and are always re-parsed against the current board before a person files one.
const PREFIX = 'doctorcre:quick-add-drafts:v1:';
const LIMIT = 30;

function validDraft(value) {
  return value && typeof value.id === 'string' && typeof value.sentence === 'string'
    && value.sentence.trim() && typeof value.dueDate === 'string'
    && (!value.dueDate || /^\d{4}-\d{2}-\d{2}$/.test(value.dueDate))
    && Number.isFinite(value.savedAt);
}

export function createLocalDrafts({ storage, viewer, now = Date.now, newId = () => crypto.randomUUID() }) {
  const key = `${PREFIX}${encodeURIComponent(String(viewer || 'unknown'))}`;
  let drafts = [];
  let persisted = true;
  try {
    const raw = storage?.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Invalid draft data');
      drafts = parsed.filter(validDraft).slice(-LIMIT)
        .map(({ id, sentence, dueDate, savedAt }) => ({ id, sentence, dueDate, savedAt }));
    }
    if (!storage) persisted = false;
  } catch {
    persisted = false;
  }

  function persist() {
    try {
      if (!storage) throw new Error('Storage unavailable');
      storage.setItem(key, JSON.stringify(drafts));
      persisted = true;
    } catch {
      persisted = false;
    }
  }

  return {
    list: () => drafts.map((draft) => ({ ...draft })),
    isPersisted: () => persisted,
    save(sentence, dueDate = '') {
      const text = String(sentence ?? '');
      const date = String(dueDate ?? '');
      if (!text.trim() || (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))) return null;
      const draft = { id: newId(), sentence: text, dueDate: date, savedAt: now() };
      drafts = [...drafts, draft].slice(-LIMIT);
      persist();
      return { ...draft };
    },
    remove(id) {
      const next = drafts.filter((draft) => draft.id !== id);
      if (next.length === drafts.length) return false;
      drafts = next;
      persist();
      return true;
    },
  };
}

export function browserDraftStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function matchingDraftId(drafts, id, sentence, dueDate) {
  const draft = drafts.find((item) => item.id === id);
  return draft?.sentence === sentence && draft.dueDate === dueDate ? draft.id : null;
}
