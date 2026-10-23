import { readWithDeadline } from './current-read.mjs';
const DEFAULT_LOOPBACK = 'http://127.0.0.1:4682';
const DEFAULT_HEADER = { 'X-CARR-Call-Mode': 'deal-room-v1' };

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

/** Narrow client for the loopback-only post-call review surface. */
export function createPostCallClient(options = {}) {
  const loopback = (options.loopbackUrl || DEFAULT_LOOPBACK).replace(/\/$/u, '');
  const fetchImpl = options.fetchImpl || fetch;
  const postHeaders = { 'content-type': 'application/json', ...DEFAULT_HEADER,
    ...(options.postHeaders || {}) };

  function loopbackFetch(path, init = {}) {
    return requestCompanion(`${loopback}${path}`, init, {fetchImpl, timeoutMs:options.timeoutMs});
  }

  return {
    async publishCallContext(context) {
      return loopbackFetch('/api/call-context', {
        method: 'POST', headers: postHeaders, body: JSON.stringify(context),
      });
    },

    async getStatus(session) {
      const body = await loopbackFetch(`/api/post-call?session=${encodeURIComponent(session)}`, {
        headers: { ...DEFAULT_HEADER },
      });
      const status = typeof body.status === 'object' ? body.status?.state : body.status || body.state;
      if (typeof status !== 'string' || !status) throw new Error('Post-call report unavailable: invalid status.');
      return body;
    },

    async syncStatus(session) {
      return loopbackFetch('/api/post-call/sync', {
        method: 'POST', headers: postHeaders, body: JSON.stringify({ session }),
      });
    },

    async createOutlookDraft(session, draftId, approvedContentHash) {
      return loopbackFetch(
        `/api/post-call/drafts/${encodeURIComponent(draftId)}/create`, {
          method: 'POST', headers: postHeaders,
          body: JSON.stringify({ session, approved_content_hash: approvedContentHash }),
        });
    },
  };
}
