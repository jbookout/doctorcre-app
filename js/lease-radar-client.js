import { fetchRead } from './auto-refresh.mjs';
import { validLeaseRadar } from './lease-radar-model.js';
export function createLeaseRadarClient({ fetchImpl = globalThis.fetch } = {}) {
  return { async readLeaseRadar({signal} = {}) {
    const response = await fetchRead('/api/v1/business/leases', {credentials:'same-origin',cache:'no-store',signal,headers:{accept:'application/json'}}, {fetchImpl});
    if (!response.ok) { const error = new Error('Lease radar unavailable'); error.status=response.status; throw error; }
    const envelope = await response.json();
    const payload = envelope.data ?? envelope;
    if (!validLeaseRadar(payload)) throw new Error('Lease radar unavailable');
    return payload;
  } };
}
