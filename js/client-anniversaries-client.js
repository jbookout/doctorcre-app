import { sessionFetch } from './private-session.js';
import { fetchRead } from './auto-refresh.mjs';
import { parseClientAnniversaries } from './ui-client-anniversaries.js';
export function createClientAnniversariesClient({fetchImpl = sessionFetch} = {}) {
  return { async read({signal} = {}) {
    const response = await fetchRead('/api/v1/intelligence/client-anniversary-read?horizon_days=30&limit=20&offset=0', {credentials:'same-origin',cache:'no-store',signal,headers:{accept:'application/json'}}, {fetchImpl});
    if (!response.ok) throw Error('Closing anniversaries unavailable');
    const envelope = await response.json();
    const payload = envelope.data ?? envelope;
    parseClientAnniversaries(payload);
    return payload;
  }};
}
