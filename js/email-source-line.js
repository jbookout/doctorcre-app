// Where an email follow-up came from and how long it has waited, in the viewer's local calendar.
const parse = value => { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date : null; };
const midnight = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** Weekdays after the email's local date, up to and including today's; null when the date is unusable. */
export function businessDaysWaiting(occurredAt, now = new Date()) {
  const sent = parse(occurredAt);
  if (!sent) return null;
  let days = 0;
  for (let cursor = midnight(sent), end = midnight(now); cursor < end;) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    if (cursor.getDay() % 6) days++;
  }
  return days;
}

export function waitingLabel(occurredAt, now = new Date()) {
  const days = businessDaysWaiting(occurredAt, now);
  if (days === null) return '';
  if (days) return `Waiting ${days} business day${days === 1 ? '' : 's'}`;
  const sent = parse(occurredAt);
  return midnight(sent) >= midnight(now) ? 'Today' : `Waiting since ${sent.toLocaleDateString('en-US', { weekday: 'long' })}`;
}

/** "From {name} · {subject} · {date}". Addresses are never shown; a sender without a name reads "Email". */
export function sourceLine({ sender, subject, occurred_at: occurredAt } = {}, now = new Date()) {
  const name = String(sender ?? '').replace(/<[^>]*>/g, '').replace(/^["'\s]+|["'\s]+$/g, '');
  const sent = parse(occurredAt);
  const date = sent && sent.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sent.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return [name && !name.includes('@') ? `From ${name}` : 'Email', String(subject ?? '').trim(), date].filter(Boolean).join(' · ');
}
