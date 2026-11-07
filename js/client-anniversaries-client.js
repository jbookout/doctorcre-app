import { sessionFetch } from './private-session.js';
import { fetchRead } from './auto-refresh.mjs';
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const date = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + "T00:00:00Z")) && (new Date(v + "T00:00:00Z")).toISOString().slice(0, 10) === v;
const label = (v) => typeof v === "string" && v.trim().length > 0;
function parseClientAnniversaries(v) {
  if (!object(v) || v.schema_version !== "client-anniversary-read.v1" || v.timezone !== "America/Chicago" || !date(v.as_of) || !object(v.query) || v.query.horizon_days !== 30 || v.query.limit !== 20 || v.query.offset !== 0 || !Array.isArray(v.rows) || v.rows.length > 20 || !object(v.coverage)) throw Error("Anniversary response unavailable");
  const { scanned, skipped_invalid, complete } = v.coverage;
  const state = v.state;
  if (state !== "ready" && state !== "empty" && state !== "unavailable" && state !== "needs_input") throw Error("Anniversary state unavailable");
  if (!integer(scanned) || scanned > 1001 || !integer(skipped_invalid) || skipped_invalid > scanned || complete !== (state === "ready" || state === "empty") || state === "ready" !== v.rows.length > 0 || !(v.next_offset === null || v.next_offset === 20 && v.rows.length === 20)) throw Error("Anniversary coverage unavailable");
  const rows = v.rows.map((r) => {
    if (!object(r) || !label(r.client_id) || !label(r.client_name) || !label(r.deal_id) || !label(r.deal_name) || !date(r.closed_on) || r.closed_on > String(v.as_of) || !date(r.anniversary_on) || !integer(r.days_until) || r.days_until > 30 || !integer(r.years) || r.years < 1 || !integer(r.deal_version) || r.deal_version < 1 || !integer(r.client_version) || r.client_version < 1 || !integer(r.party_version) || r.party_version < 1 || !["closed", "invoiced"].includes(String(r.phase)) || r.outcome !== "won" || r.evidence_ref !== `deal:${r.deal_id}@${r.deal_version}#closed_on`) throw Error("Anniversary row unavailable");
    return { client_id: r.client_id, client_name: r.client_name, deal_id: r.deal_id, deal_name: r.deal_name, closed_on: r.closed_on, anniversary_on: r.anniversary_on, days_until: r.days_until, years: r.years, evidence_ref: r.evidence_ref };
  });
  const keys = rows.map((r) => `${r.anniversary_on}/${r.client_id}/${r.deal_id}/${r.closed_on}`);
  if (new Set(keys).size !== keys.length || keys.join() !== [...keys].sort().join()) throw Error("Anniversary order unavailable");
  return { schema_version: v.schema_version, state, as_of: v.as_of, timezone: v.timezone, rows, coverage: { scanned, skipped_invalid, complete }, next_offset: v.next_offset };
}

export { parseClientAnniversaries };
export function createClientAnniversariesClient({fetchImpl = sessionFetch} = {}) {
  return { async read({signal} = {}) {
    const response = await fetchRead('/api/v1/intelligence/client-anniversary-read?horizon_days=30&limit=20&offset=0', {credentials:'same-origin',cache:'no-store',signal,headers:{accept:'application/json'}}, {fetchImpl});
    if (!response.ok && response.status !== 503) throw Error('Closing anniversaries unavailable');
    const payload = await response.json();
    if (!response.ok && payload.state !== 'unavailable') throw Error('Closing anniversaries unavailable');
    parseClientAnniversaries(payload);
    return payload;
  }};
}
