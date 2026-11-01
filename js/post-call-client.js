import { readWithDeadline } from './current-read.mjs';
export const CALL_MODE_URL = 'http://127.0.0.1:4682';
export const CALL_MODE_HEADER = Object.freeze({ 'X-CARR-Call-Mode': 'deal-room-v1' });
// Every state the companion reports (call-mode.py session_status). A post-call
// state is still a reachable recorder; refusing one hid Call Mode as offline.
export const CALL_MODE_STATES = Object.freeze(['idle','recording','transcribing','ready_to_extract','awaiting_context','ready_review','blocked','needs_attention','filed','state_unknown']);

// One deadline includes headers and JSON, even when the transport ignores abort.
export async function requestCompanion(url, init = {}, {fetchImpl = fetch, timeoutMs = 15000, fallback = 'Call Mode request failed.'} = {}) {
  const write = init.method === 'POST';
  try {
    return await readWithDeadline(async signal => {
      const response = await fetchImpl(url, {targetAddressSpace:'loopback', ...init, signal});
      let body;
      try { body = await response.json(); }
      catch { throw Object.assign(new Error('Invalid companion response'),{status:response.ok ? undefined : response.status}); }
      if (!response.ok) throw Object.assign(new Error(body?.error || fallback), {status:response.status, payload:body});
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid companion response');
      return body;
    }, {timeoutMs});
  } catch (cause) {
    const unknown = write && (!cause.status || cause.status >= 500);
    const message = cause.code === 'read_timeout' ? 'Local Call Mode timed out.' : cause.status ? fallback : 'Local Call Mode could not read the companion response.';
    throw Object.assign(new Error(`${message}${unknown ? ' Outcome unknown. Check local state or the report before retrying.' : ' Retry to check the local companion.'}`),
      {cause, status:cause.status, outcomeUnknown:unknown, code:cause.code});
  }
}
