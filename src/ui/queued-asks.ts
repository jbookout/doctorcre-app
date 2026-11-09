export type AskRequest = Readonly<{ idempotency_key: string; conversation_id: string; body: string }>;
type Kind = 'queued' | 'submitting' | 'unknown' | 'refused' | 'accepted';
export type QueuedAsk = { kind: Kind; request: AskRequest };
type Options = {
  storage: Storage; actor: string; conversation: string; online(): boolean; uuid(): string;
  submit(request: AskRequest): Promise<unknown>; changed?(): void;
};
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
function parse(value: string | null): QueuedAsk | null {
  if (!value) return null;
  const v: unknown = JSON.parse(value);
  if (!v || typeof v !== 'object' || !('kind' in v) || !('request' in v)) return null;
  const r = v.request;
  if (!r || typeof r !== 'object' || !('body' in r) || !('conversation_id' in r) || !('idempotency_key' in r)
    || typeof r.body !== 'string' || !r.body.trim() || r.body.length > 20000 || !uuid(r.conversation_id) || !uuid(r.idempotency_key)) return null;
  const request = Object.freeze({ body:r.body, conversation_id:r.conversation_id, idempotency_key:r.idempotency_key });
  switch (v.kind) {
    case 'queued': case 'submitting': case 'unknown': case 'refused': case 'accepted': return { kind:v.kind, request };
    default: return null;
  }
}
function outcome(value: unknown, request: AskRequest): 'accepted' | 'refused' | 'unknown' {
  if (!value || typeof value !== 'object' || !('contract' in value) || value.contract !== 'doc-request.v1'
    || !('conversation_id' in value) || value.conversation_id !== request.conversation_id
    || !('idempotency_key' in value) || value.idempotency_key !== request.idempotency_key || !('status' in value)) return 'unknown';
  if (value.status === 'accepted' && 'ok' in value && value.ok === true
    && 'request_msg_id' in value && value.request_msg_id === request.idempotency_key) return 'accepted';
  if (value.status === 'refused' && 'reason' in value && typeof value.reason === 'string') return 'refused';
  return 'unknown';
}
export function createAskOutbox(o: Options) {
  if (!o.actor || !uuid(o.conversation)) throw Error('Open a conversation before writing.');
  const prefix = `doctorcre:asks:v1:${encodeURIComponent(o.actor)}:${o.conversation}:`;
  const draftKey = prefix + 'draft';
  let busy = false, stopped = false;
  const retries = new Set<string>();
  function savedDraft(): { text: string; version: number } {
    const raw = o.storage.getItem(draftKey);
    if (!raw) return { text:'', version:0 };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string'
      || !('version' in value) || typeof value.version !== 'number') throw Error('Device draft could not be read.');
    return { text:value.text, version:value.version };
  }
  const draft = () => savedDraft().text;
  let draftSnapshot = o.storage.getItem(draftKey);
  const entries = (): QueuedAsk[] => {
    const rows: QueuedAsk[] = [];
    // eslint-disable-next-line no-restricted-syntax -- Single finite scan of this device's storage; no network reads.
    for (let i=0; i<o.storage.length; i++) {
      const key = o.storage.key(i);
      if (!key?.startsWith(prefix) || key === draftKey) continue;
      const row = parse(o.storage.getItem(key));
      if (row && row.request.conversation_id === o.conversation && key === prefix + row.request.idempotency_key) rows.push(row);
    }
    return rows;
  };
  const put = (row: QueuedAsk) => {
    const key = prefix + row.request.idempotency_key;
    const current = parse(o.storage.getItem(key));
    if (current?.kind === 'accepted') return;
    o.storage.setItem(key, JSON.stringify(row));
    o.changed?.();
  };
  for (const row of entries()) if (row.kind === 'submitting') put({ ...row, kind:'unknown' });
  async function send(row: QueuedAsk) {
    if (stopped || !o.online()) return;
    put({ ...row, kind:'submitting' });
    let kind: Kind = 'unknown';
    try { kind = outcome(await o.submit(row.request), row.request); } catch { /* No receipt proves no outcome. */ }
    if (!stopped) put({ ...row, kind });
  }
  async function run(only?: string) {
    if (stopped || !o.online()) return;
    if (only) retries.add(only);
    if (busy) return;
    busy = true;
    const attempted = new Set<string>();
    try {
      // eslint-disable-next-line no-restricted-syntax -- Re-read newly queued asks after each await; each key gets at most one attempt in this drain.
      while (!stopped && o.online()) {
        const row = entries().find(row => !attempted.has(row.request.idempotency_key)
          && (row.kind === 'queued' || row.kind === 'unknown' || (row.kind === 'refused' && retries.has(row.request.idempotency_key)))
          && (!only || retries.has(row.request.idempotency_key) || row.kind === 'queued'));
        if (!row) break;
        attempted.add(row.request.idempotency_key);
        await send(row);
      }
    } finally { busy = false; retries.clear(); }
  }
  return {
    draft, entries,
    appendDraft(block: string, expected: string) {
      if (stopped) throw Error("This conversation is closed. Reopen it before inserting.");
      const current = o.storage.getItem(draftKey);
      if (current !== draftSnapshot || draft() !== expected) throw Error("The draft changed in another tab. Reopen it before inserting.");
      const text = expected ? expected + "\n\n" + block : block;
      if (text.length > 20000) throw Error("The ask would exceed 20,000 characters. Nothing was inserted.");
      o.storage.setItem(draftKey, JSON.stringify({ text, version:savedDraft().version + 1 }));
      draftSnapshot = o.storage.getItem(draftKey);
      return text;
    },
    saveDraft(text: string) { o.storage.setItem(draftKey, JSON.stringify({ text, version:savedDraft().version + 1 })); draftSnapshot = o.storage.getItem(draftKey); },
    enqueue(text = draft()) {
      if (!text.trim() || text.length > 20000) throw Error('Write an ask of up to 20,000 characters.');
      if (draft() !== text) throw Error('The draft changed in another tab. Reopen it before sending.');
      const snapshot = o.storage.getItem(draftKey);
      const key = o.uuid();
      if (!uuid(key) || o.storage.getItem(prefix + key)) throw Error('The request key is unavailable. Try again.');
      const request = Object.freeze({ idempotency_key:key, conversation_id:o.conversation, body:text });
      put({ kind:'queued', request });
      if (o.storage.getItem(draftKey) === snapshot) o.storage.removeItem(draftKey);
      draftSnapshot = o.storage.getItem(draftKey);
      return request;
    },
    // eslint-disable-next-line no-restricted-syntax -- Single explicit trigger drains saved asks, bounded to one attempt per key.
    flush: () => run(), retry: (key: string) => run(key), stop() { stopped = true; },
  };
}
