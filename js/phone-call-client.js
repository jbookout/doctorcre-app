import { sessionFetch } from './private-session.js';
const PREFIX = '/api/v1/call-sessions';
export const sessionId = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value || '');
function verifiedSession(value, id) {
  if (value?.schema_version !== 1 || !sessionId(value.session_id) || (id && value.session_id !== id) ||
      typeof value.state !== 'string' || !value.state ||
      typeof value.transferred !== 'boolean' || typeof value.filed !== 'boolean')
    throw new Error('Call status could not be verified. Saved audio has been kept.');
  return value;
}
export function createPhoneCallClient() {
  async function request(path, init = {}, id) {
    let response;
    try { response = await sessionFetch(path, { ...init, credentials: 'same-origin', signal: AbortSignal.timeout(init.method === 'PUT' ? 130000 : 15000) }); }
    catch { throw new Error(path.endsWith('/answers') ? 'The answer could not be sent. Please retry.' : 'The call service did not respond. Your saved audio stays on this device.'); }
    if (!response.ok) {
      const { error } = await response.json().catch(() => ({}));
      const messages = {
        handoff_full: 'The upload queue is full. Try again later. Your audio stays on this device.',
        upload_rate_limit: 'Too many uploads in a short time. Wait a minute and try again.',
        recording_mismatch: 'This recording does not match the upload already in progress. Your audio stays on this device.',
        daily_admission_limit: 'Daily recording limit reached. Your audio is still on this device.',
      };
      if (path.endsWith('/answers')) {
        const answerMessages = { question_already_resolved: 'This question has already been answered.', question_not_found: 'This question is no longer available.', not_found: 'This call is unavailable or belongs to another partner.', invalid_question_answer: 'This answer is invalid. Check it and try again.', key_reuse: 'This answer could not be accepted. Refresh the call and try again.' };
        throw Object.assign(new Error(answerMessages[error] || 'The answer could not be sent. Please retry.'), { code: error });
      }
      throw new Error(messages[error] || (response.status === 400 ? 'This recording could not be accepted. Check its length and file before trying again.' : response.status === 413 ? 'This recording is too large. Choose a file up to 50 MiB.' : response.status === 415 ? 'This audio format is not supported. Try an MP4, WAV, MP3 or WebM recording.' : response.status === 409 ? 'An upload is already in progress or this recording does not match. Your audio stays on this device.' : response.status === 429 ? 'The upload queue is full or too many uploads were attempted. Try again later.' : 'Call service unavailable. Your saved audio stays on this device.'));
    }
    const value = await response.json();
    if (path === '/auth/session') return value;
    if (path.endsWith('/answers')) {
      const body = JSON.parse(init.body);
      if (value?.ok !== true || value.session_id !== id || value.question_id !== body.question_id || value.answer !== body.answer) throw new Error('The answer could not be confirmed. Please retry.');
      return value;
    }
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
    answer: (id, body) => request(`${path(id)}/answers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, id),
    report: id => request(`${path(id)}/report`, {}, id),
  };
}
