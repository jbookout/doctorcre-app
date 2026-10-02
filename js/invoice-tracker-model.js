import { localToday } from './calendar-model.js';
const DAY = 86_400_000;
export const AGES = ['0–30 days', '31–60 days', '61–90 days', '91+ days'];
export const invoiceHref = key => `/invoices?invoice=${encodeURIComponent(key)}`;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const nullableDate = value => value === null || date(value);
export function validInvoiceTracker(payload) {
  const ids = new Set();
  return payload?.schema_version === 'invoice-tracker.v1' && typeof payload.actor === 'string'
    && Number.isFinite(Date.parse(payload.observed_at)) && Array.isArray(payload.entries)
    && payload.entries.every(row => {
      if (!row || typeof row.deal_id !== 'string' || !row.deal_id || typeof row.name !== 'string'
        || !['closed_on', 'invoiced_on', 'commission_invoiced_on', 'received_on', 'due_on'].every(key => nullableDate(row[key]))
        || !date(row.as_of) || !['owner','lane','outcome'].every(key => row[key] === null || typeof row[key] === 'string')) return false;
      if (row.commission_id !== null && (typeof row.commission_id !== 'string' || !row.commission_id
        || !['expected','invoiced','received'].includes(row.status) || !Number.isInteger(row.base_version) || row.base_version < 1)) return false;
      if (row.gross_amount !== null && !(typeof row.gross_amount === 'number' || typeof row.gross_amount === 'string')) return false;
      if (row.gross_amount !== null && (!/^\d+(\.\d{1,2})?$/.test(String(row.gross_amount)) || !Number.isFinite(Number(row.gross_amount)))) return false;
      if (row.status === 'received' && (!date(row.received_on) || !date(row.commission_invoiced_on))) return false;
      if (row.status === 'invoiced' && !date(row.commission_invoiced_on)) return false;
      const key = row.commission_id || `awaiting:${row.deal_id}`;
      if (ids.has(key)) return false;
      ids.add(key); return true;
    });
}
// One projection decides status, invoice age and Home attention. Client-benefit
// values are deliberately outside this contract, including unknown amounts.
export function projectInvoices(payload, { today = localToday(), scope = 'team' } = {}) {
  if (!validInvoiceTracker(payload) || !date(today)) return null;
  return payload.entries.filter(row => scope !== 'mine' || row.owner === payload.actor).map(row => {
    const invoiceDay = row.commission_id ? row.commission_invoiced_on : row.invoiced_on;
    const status = row.status === 'received' ? 'paid' : invoiceDay && row.status !== 'expected' ? 'unpaid' : 'awaiting';
    const age = status === 'awaiting' ? null : Math.max(0, Math.floor((Date.parse(status === 'paid' ? row.received_on : today) - Date.parse(invoiceDay)) / DAY));
    const bucket = age === null ? null : age > 90 ? 3 : age > 60 ? 2 : age > 30 ? 1 : 0;
    return { ...row, key: row.commission_id || `awaiting:${row.deal_id}`, invoiceDay, status, age, bucket,
      amount: row.gross_amount === null ? null : Number(row.gross_amount),
      overdue: status === 'unpaid' && row.due_on !== null && row.due_on < today,
      canMarkPaid: status === 'unpaid' && Boolean(row.commission_id) };
  }).sort((a, b) => Number(b.overdue) - Number(a.overdue) || (b.age ?? -1) - (a.age ?? -1) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
export function invoiceSummary(rows) {
  const unpaid = rows.filter(row => row.status === 'unpaid');
  return { unpaid: unpaid.length, owed: unpaid.reduce((sum,row)=>sum+(row.amount ?? 0),0),
    unknown: unpaid.filter(row=>row.amount===null).length, awaiting: rows.filter(row=>row.status==='awaiting').length,
    paid: rows.filter(row=>row.status==='paid').length,
    buckets: AGES.map((label,index)=>({label, index, count:unpaid.filter(row=>row.bucket===index).length,
      amount:unpaid.filter(row=>row.bucket===index).reduce((sum,row)=>sum+(row.amount ?? 0),0)})) };
}
export const invoiceMoney = value => value === null ? '—' : new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value);
export const invoiceDate = value => value ? new Date(`${value}T12:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
