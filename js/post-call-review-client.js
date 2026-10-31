import { requestCompanion, CALL_MODE_URL, CALL_MODE_HEADER } from './post-call-client.js';

/** Narrow client for the loopback-only post-call review surface. */
export function createPostCallClient(options = {}) {
  const loopback = (options.loopbackUrl || CALL_MODE_URL).replace(/\/$/u, '');
  const fetchImpl = options.fetchImpl || fetch;
  const postHeaders = { 'content-type': 'application/json', ...CALL_MODE_HEADER,
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
        headers: { ...CALL_MODE_HEADER },
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
    async resolveQuestion(session, questionId, resolution) {
      return loopbackFetch(`/api/post-call/questions/${encodeURIComponent(questionId)}/resolve`, {
        method: 'POST', headers: postHeaders, body: JSON.stringify({ session, resolution }),
      });
    },
  };
}
