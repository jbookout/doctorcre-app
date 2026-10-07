import { toDay, addMonths } from './calendar-model.js';
export { addMonths } from './calendar-model.js';

export function radarToday(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const part = type => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export const LEASE_RADAR_SCHEMA = 'lease-radar.v1';
const quarterKey = day => `${day.slice(0, 4)}-Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;
function leaseUrgency(day, today) {
  return day <= addMonths(today, 6) ? { tone: 'urgent', label: 'Within 6 months' }
    : day <= addMonths(today, 12) ? { tone: 'soon', label: '6–12 months' }
      : { tone: 'later', label: '12–24 months' };
}
export function validLeaseRadar(payload) {
  const text = value => typeof value === 'string' && value.length > 0;
  const nullableText = value => value === null || typeof value === 'string';
  const nullableDay = value => value === null || typeof value === 'string' && toDay(value) === value;
  return payload?.schema_version === LEASE_RADAR_SCHEMA && text(payload.actor)
    && typeof payload.observed_at === 'string' && Number.isFinite(Date.parse(payload.observed_at))
    && toDay(payload.window?.starts_on) === payload.window?.starts_on && !!payload.window?.starts_on
    && payload.window.ends_on === addMonths(payload.window.starts_on, 24)
    && Array.isArray(payload.leases) && new Set(payload.leases.map(row => row?.id)).size === payload.leases.length
    && payload.leases.every(row => row && text(row.id) && text(row.client_id)
      && typeof row.client_name === 'string' && nullableDay(row.expiration_on)
      && (row.expiration_on === null || row.expiration_on >= payload.window.starts_on && row.expiration_on <= payload.window.ends_on)
      && ['current', 'legacy_unverified'].includes(row.lease_status)
      && ['deal_id','client_status','client_status_label','city','state','vertical','owner','owner_label','contact_state','options_note','evidence_ref','touch_id','touch_summary','touch_owner','notice_note'].every(field => nullableText(row[field]))
      && ['commencement_on','executed_on','touch_due_on','notice_on'].every(field => nullableDay(row[field]))
      // The producer's SQL expression is nullable when no action exists.
      && (row.touch_eligible === null || typeof row.touch_eligible === 'boolean')
      && (row.touch_eligible !== true || text(row.touch_id) && text(row.touch_owner) && row.touch_due_on !== null));
}

export function projectLeaseRadar(payload, { scope = 'team', today = radarToday() } = {}) {
  if (!validLeaseRadar(payload)) return null;
  const end = addMonths(today, 24);
  // A dated response from before midnight is never represented as full coverage
  // of tomorrow's moving horizon. Auto-refresh immediately replaces it.
  if (payload.window.starts_on !== today) return null;
  const rows = payload.leases.filter(row => scope !== 'mine' || row.owner === payload.actor);
  const gaps = rows.filter(row => row.expiration_on === null);
  const dated = rows.filter(row => row.expiration_on && row.expiration_on >= today && row.expiration_on <= end)
    .map(row => ({ ...row, ...leaseUrgency(row.expiration_on, today) }))
    .sort((a, b) => a.expiration_on.localeCompare(b.expiration_on) || a.id.localeCompare(b.id));
  const quarters = [];
  let day = `${today.slice(0,4)}-${String(Math.floor((Number(today.slice(5,7)) - 1) / 3) * 3 + 1).padStart(2,'0')}-01`;
  while (day <= end) { const key = quarterKey(day); quarters.push({key, label: key.replace(/(\d+)-Q(\d)/, 'Q$2 $1'), leases: dated.filter(row => quarterKey(row.expiration_on) === key)}); day = addMonths(day, 3); }
  return { dated, gaps, quarters, today, end, observedAt: payload.observed_at };
}

export function pastClientTouches(payload, { scope = 'team', today = radarToday(), limit = 4 } = {}) {
  const model = projectLeaseRadar(payload, {today});
  if (!model) return null;
  const touches = new Map();
  for (const row of [...model.dated, ...model.gaps]) {
    if (row.touch_eligible !== true || !row.touch_id || !row.touch_due_on || row.touch_due_on > today) continue;
    if (scope === 'mine' && row.touch_owner !== payload.actor) continue;
    if (!touches.has(row.touch_id)) touches.set(row.touch_id, row);
  }
  return [...touches.values()].sort((a,b) => a.touch_due_on.localeCompare(b.touch_due_on) || a.touch_id.localeCompare(b.touch_id)).slice(0,limit);
}

export function leaseRadarAddress({view='timeline',scope='team',search='',quarter=null,lease=null}, current='/leases') {
  const url = new URL(current, 'http://fixture.local');
  for (const [key,value,defaultValue] of [['view',view,'timeline'],['scope',scope,'team'],['q',search,''],['quarter',quarter,null],['lease',lease,null]]) {
    if (value && value !== defaultValue) url.searchParams.set(key,value); else url.searchParams.delete(key);
  }
  return url.pathname + url.search + url.hash;
}
export function parseLeaseRadarAddress(search='') {
  const params=new URLSearchParams(search);
  return {view:params.get('view')==='gaps'?'gaps':'timeline',scope:params.get('scope')==='mine'?'mine':'team',search:params.get('q')||'',quarter:/^\d{4}-Q[1-4]$/.test(params.get('quarter'))?params.get('quarter'):null,lease:params.get('lease')||null};
}
