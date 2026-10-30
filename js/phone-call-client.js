import { sessionFetch } from './private-session.js';
const PREFIX = '/api/v1/call-sessions';
export const sessionId = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value || '');
function verifiedSession(value, id) {
  if (value?.schema_version !== 1 || !sessionId(value.session_id) || (id && value.session_id !== id) ||
      !['pending', 'queued', 'expired', 'transferred', 'ready_review', 'filed', 'needs_attention', 'held_review'].includes(value.state) ||
      typeof value.transferred !== 'boolean' || typeof value.filed !== 'boolean')
    throw new Error('Call status could not be verified. Saved audio has been kept.');
  return value;
}
export function createPhoneCallClient() {
  async function request(path, init = {}, id) {
    const response = await sessionFetch(path, { ...init, credentials: 'same-origin', signal: AbortSignal.timeout(init.method === 'PUT' ? 130000 : 15000) });
    if (!response.ok) throw new Error(response.status === 400 ? 'This recording could not be accepted. Check its length and file before trying again.' : response.status === 413 ? 'This recording is too large. Choose a file up to 50 MiB.' : response.status === 415 ? 'This audio format is not supported. Try an MP4, WAV, MP3 or WebM recording.' : response.status === 429 ? 'Daily recording limit reached. Your audio is still on this device.' : 'Call service unavailable. Your saved audio stays on this device.');
    const value = await response.json();
    if (path === '/auth/session') return value;
    verifiedSession(value, id);
    if (path.endsWith('/report') && (!Array.isArray(value.actions) || !Array.isArray(value.deal_updates) ||
        (value.report && (typeof value.report.summary !== 'string' ||
          !['decisions', 'open_questions'].every(key => Array.isArray(value.report[key]) && value.report[key].every(s => typeof s === 'string'))))))
      throw new Error('Call report could not be verified. Refresh review to retry.');
    return value;
  }
  function path(id) { if (!sessionId(id)) throw new Error('Enter a valid call session ID.'); return `${PREFIX}/${id}`; }
  return {
    session: () => request('/auth/session'),
    admit: metadata => request(PREFIX, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(metadata) }),
    transfer: (id, audio, mime) => request(`${path(id)}/transfer`, { method: 'PUT', headers: { 'content-type': mime }, body: audio }, id),
    status: id => request(path(id), {}, id),
    report: id => request(`${path(id)}/report`, {}, id),
  };
}
