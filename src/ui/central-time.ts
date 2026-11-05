const zone = 'America/Chicago';
function localParts(date: Date) {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
export function tomorrowCentral(now: Date) {
  const date = new Date(`${localParts(now).slice(0, 10)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return `${date.toISOString().slice(0, 10)}T09:00`;
}
export function centralInstant(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw Error('Choose a valid return time.');
  const wall = Date.parse(`${value}:00Z`);
  const candidates = [5, 6].map(offset => new Date(wall + offset * 3600000)).filter(date => localParts(date) === value);
  if (candidates.length !== 1) throw Error('Choose an unambiguous Central time outside the daylight-saving clock change.');
  const chosen = candidates[0];
  if (!chosen) throw Error('Choose a valid return time.');
  return chosen.toISOString();
}
