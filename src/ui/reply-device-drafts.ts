type Draft = { baseVersion: number; subject: string; body: string; to: string[]; cc: string[] };
type Row = { id: string; version: number; reply_draft: Omit<Draft, 'baseVersion'> };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

function parse(value: unknown): Draft | null {
  if (!value || typeof value !== 'object' || !('baseVersion' in value) || !Number.isSafeInteger(value.baseVersion)
    || typeof value.baseVersion !== 'number' || value.baseVersion < 1
    || !('subject' in value) || typeof value.subject !== 'string' || value.subject.length > 998
    || !('body' in value) || typeof value.body !== 'string' || value.body.length > 20000
    || !('to' in value) || !Array.isArray(value.to) || !value.to.every(item => typeof item === 'string')
    || !('cc' in value) || !Array.isArray(value.cc) || !value.cc.every(item => typeof item === 'string')) return null;
  return { baseVersion: value.baseVersion, subject: value.subject, body: value.body, to: value.to, cc: value.cc };
}

export function createReplyDeviceDrafts(storage: Storage | null, actor: string) {
  const key = (id: string) => `doctorcre:reply-device:v1:${encodeURIComponent(actor)}:${encodeURIComponent(id)}`;
  return {
    restore(row: Row) {
      if (!actor) return null;
      try {
        const draft = parse(JSON.parse(storage?.getItem(key(row.id)) || 'null'));
        return draft && { ...draft, conflict: draft.baseVersion !== row.version
          || JSON.stringify(draft.to) !== JSON.stringify(row.reply_draft.to)
          || JSON.stringify(draft.cc) !== JSON.stringify(row.reply_draft.cc) };
      } catch { return null; }
    },
    save(id: string, draft: Draft) {
      if (!actor || !storage) return false;
      const parsed = parse(draft);
      if (!parsed) return false;
      try { storage.setItem(key(id), JSON.stringify(parsed)); return true; } catch { return false; }
    },
    remove(id: string, expected?: Draft) {
      try {
        const current = parse(JSON.parse(storage?.getItem(key(id)) || 'null'));
        if (expected && current && (current.baseVersion !== expected.baseVersion || current.subject !== expected.subject || current.body !== expected.body
          || JSON.stringify(current.to) !== JSON.stringify(expected.to) || JSON.stringify(current.cc) !== JSON.stringify(expected.cc))) return;
        storage?.removeItem(key(id));
      } catch { /* Keep the current editor usable when storage is denied. */ }
    },
  };
}
