import { BUSINESS_TIME_ZONE } from './business-date.js';

const parse = value => { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date : null; };
export function relativeAge(occurredAt, now = new Date()) {
  const sent = parse(occurredAt);
  if (!sent) return 'time unavailable';
  const minutes = Math.max(0, Math.floor((now.getTime() - sent.getTime()) / 60000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago`
    : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

export function sourceLine({ sender, occurred_at: occurredAt } = {}, now = new Date()) {
  const name = String(sender ?? '').split('<', 1)[0].replace(/^["'\s]+|["'\s]+$/g, '');
  return `${name && !name.includes('@') ? `From ${name}'s email` : 'From an email'}, ${relativeAge(occurredAt, now)}`;
}

export function sourceTime(occurredAt, now = new Date()) {
  const sent = parse(occurredAt);
  if (!sent) return 'Time unavailable';
  const year = date => date.toLocaleDateString('en-US', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric' });
  return sent.toLocaleString('en-US', { timeZone: BUSINESS_TIME_ZONE, month: 'short', day: 'numeric',
    ...(year(sent) === year(now) ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' });
}
