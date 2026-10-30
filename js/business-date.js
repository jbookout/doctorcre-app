export const BUSINESS_TIME_ZONE = 'America/Chicago';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit' });

export function businessDay(now = new Date()) {
  const parts = Object.fromEntries(dayFormat.formatToParts(now).map(({type,value}) => [type,value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function overnightCutoff(now = new Date()) {
  const previous = new Date(`${businessDay(now)}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const target = new Date(`${previous.toISOString().slice(0,10)}T17:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(target);
  const values = Object.fromEntries(parts.map(({type,value}) => [type,value]));
  const wall = Date.parse(`${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}Z`);
  return new Date(target.valueOf() + target.valueOf() - wall).toISOString();
}

const instantFormat = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TIME_ZONE, year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true, timeZoneName:'short' });
/** One display of a recorded instant everywhere: business time zone, with its zone label (CDT/CST). */
export function formatBusinessInstant(value, missing = 'Date not recorded') {
  const date = new Date(value || NaN);
  return Number.isFinite(date.getTime()) ? instantFormat.format(date) : missing;
}
