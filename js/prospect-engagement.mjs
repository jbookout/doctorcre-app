import { unknownMcpOutcome } from './mcp-requests.mjs';
import { uuidv4 } from './uuid.js';

const refusals = new Set([
  'human_confirmation_required',
  'unauthorized', 'not_authenticated', 'forbidden',
  'invalid_engagement_status', 'engagement_reason_required', 'version_conflict',
  'not_found', 'client_merged_away', 'not_a_prospect', 'prospect_party_protected',
  'prospect_lead_protected', 'missing_required', 'value_not_in_declared_vocabulary',
]);

export function confirmedEngagementRefusal(error) {
  return [401, 403].includes(error.status) || refusals.has(error.payload?.error || error.code);
}

const writers = new WeakMap();
const stores = new WeakMap();
const prefix = 'doctorcre:prospect-write:';
const matches = (request, row) => row?.client_id === request.client_id && row.status === request.status && row.version > request.base_version;
export function engagementStorage(win = globalThis.window) {
  try { return win?.sessionStorage; } catch { return undefined; }
}

export function createEngagementWriter(send, { storage = engagementStorage(), uuid = uuidv4 } = {}) {
  const entries = storage && stores.get(storage) || new Map();
  const loaded = storage && stores.has(storage);
  if (storage) stores.set(storage, entries);
  const key = args => JSON.stringify([args.expected_actor || null, args.client_id]);
  try {
    // eslint-disable-next-line no-restricted-syntax -- Loads saved requests once, visiting at most storage.length keys; zero network reads.
    for (let i = 0; i < (loaded ? 0 : storage?.length); i++) {
      const name = storage.key(i);
      if (!name?.startsWith(prefix)) continue;
      const request = JSON.parse(storage.getItem(name));
      if (request?.client_id && request.idempotency_key && name === prefix + key(request))
        entries.set(key(request), { request: Object.freeze(request), attempted: true, sending: false });
    }
  } catch { /* Storage can be unavailable; the in-memory request still survives retries. */ }
  function save(entry) {
    try { storage?.setItem(prefix + key(entry.request), JSON.stringify(entry.request)); } catch { /* Keep the in-memory request. */ }
  }
  function clear(entry) {
    if (entries.get(key(entry.request)) !== entry) return;
    entries.delete(key(entry.request));
    try { storage?.removeItem(prefix + key(entry.request)); } catch { /* Keep other requests. */ }
  }
  function confirm(row, actor) {
    const entry = write.get(row?.client_id, actor);
    if (!entry || !matches(entry.request, row)) return false;
    clear(entry);
    return true;
  }
  async function write(args, { readBack, beforeSend } = {}) {
    const identity = key(args);
    let entry = entries.get(identity);
    if (!entry) {
      entry = { request: Object.freeze({ ...args, idempotency_key: args.idempotency_key || uuid() }), attempted: false, sending: false };
      entries.set(identity, entry);
      save(entry);
    }
    if (entry.sending) return entry.flight;
    entry.sending = true;
    const reached = async () => {
      try {
        if (!matches(entry.request, await readBack?.(entry.request))) return false;
        clear(entry); return true;
      } catch { return false; }
    };
    entry.flight = (async () => {
      try {
        if (entry.attempted && await reached()) return { ok: true };
        try { await beforeSend?.(entry.request); } catch (error) { throw unknownMcpOutcome(error); }
        entry.attempted = true;
        const result = await send(entry.request);
        if (result?.ok !== true) throw unknownMcpOutcome(result);
        clear(entry);
        return result;
      } catch (error) {
        if (confirmedEngagementRefusal(error)) { clear(entry); throw error; }
        if (await reached()) return { ok: true };
        throw unknownMcpOutcome(error);
      } finally { entry.sending = false; }
    })();
    return entry.flight;
  }
  write.get = (clientId, actor) => entries.get(key({ client_id: clientId, expected_actor: actor }));
  write.values = actor => [...entries.values()].filter(entry => (entry.request.expected_actor || null) === (actor || null));
  write.confirm = confirm;
  return write;
}

export function engagementWriterFor(client, storage) {
  if (client.setProspectEngagementStatus?.confirm) return client.setProspectEngagementStatus;
  if (!writers.has(client)) writers.set(client, createEngagementWriter(args => client.setProspectEngagementStatus(args), { storage }));
  return writers.get(client);
}
