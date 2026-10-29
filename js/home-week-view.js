import { homeWeek } from './home-week.js';
import { BUSINESS_TIME_ZONE } from './business-date.js';
import { onDialogClosed } from './dialog-lifecycle.js';
import { escapeText as E } from './change-receipts.mjs';

const dayLabel = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const shortDay = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' });

export function mountHomeWeek({ document, host }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'home-detail home-week-detail';
  dialog.setAttribute('aria-labelledby', 'homeWeekDetailTitle');
  document.body.append(dialog);
  let entries = new Map(), selected = null, openerKey = null, restoreDay = false;
  const findKey = key => [...host.querySelectorAll('[data-home-key]')].find(node => node.dataset.homeKey === key);
  const cleanup = () => {
    if (dialog.open || !selected) return;
    const day = selected?.day;
    dialog.replaceChildren(); selected = null;
    const active = document.activeElement;
    if (restoreDay || !active || active === document.body || dialog.contains(active)) {
      const opener = findKey(openerKey);
      (opener || host.querySelector(`[data-home-week-date="${day}"]`) || host.querySelector('a'))?.focus();
    }
    openerKey = null; restoreDay = false;
  };
  const closed = onDialogClosed(dialog, cleanup);
  const close = (sourceChanged = false) => { restoreDay = sourceChanged; dialog.close(); queueMicrotask(cleanup); };
  const chip = entry => `<button type="button" class="home-week-entry" data-home-week-entry="${E(entry.key)}" data-home-key="week:${E(entry.key)}" aria-label="${E(entry.label)}"><time datetime="${E(entry.start || entry.day)}">${E(entry.time)}</time><strong>${E(entry.label)}</strong></button>`;
  const html = ({ agenda, calendar, today }) => {
    const days = homeWeek({ agenda, calendar, today });
    const next = new Map(days.flatMap(day => [...day.allDay, ...day.timed]).map(entry => [entry.key, entry]));
    if (selected && JSON.stringify(next.get(selected.key)) !== JSON.stringify(selected)) close(true);
    entries = next;
    return `<p class="home-week-zone">${BUSINESS_TIME_ZONE}</p><div class="home-week-strip" role="group" aria-label="Choose calendar day">${days.map(({ day }) => `<button type="button" data-home-week-day="${day}" data-home-key="week-day:${day}" aria-label="${E(dayLabel(day))}"${day === today ? ' aria-current="date"' : ''}><span>${shortDay(day)}</span><strong>${Number(day.slice(-2))}</strong></button>`).join('')}</div><div class="home-week">${days.map(({ day, allDay, timed }) => `<section class="home-day${day === today ? ' today' : ''}" tabindex="-1" aria-label="${E(dayLabel(day))}" data-home-week-date="${day}"><header><span>${shortDay(day)}</span><strong>${Number(day.slice(-2))}</strong>${day === today ? '<span class="home-week-today">Today</span>' : ''}</header>${allDay.length ? `<div class="home-week-all-day"><h3>All day</h3>${allDay.map(chip).join('')}</div>` : ''}<div class="home-week-timed">${timed.map(chip).join('')}</div>${!allDay.length && !timed.length ? '<p class="home-week-empty">No returned items</p>' : ''}</section>`).join('')}</div>`;
  };
  const click = event => {
    const day = event.target.closest('[data-home-week-day]');
    if (day) {
      host.querySelector(`[data-home-week-date="${day.dataset.homeWeekDay}"]`)?.scrollIntoView({ block: 'nearest', inline: 'start', behavior: 'instant' });
      return true;
    }
    const button = event.target.closest('[data-home-week-entry]');
    const entry = entries.get(button?.dataset.homeWeekEntry);
    if (!entry) return false;
    selected = entry; openerKey = button.dataset.homeKey;
    const date = `${dayLabel(entry.day)}${entry.time === 'All day' ? ' · All day' : ` · ${entry.time}`}`;
    const facts = entry.type === 'meeting'
      ? `<p>${E(entry.location || 'Place not provided')}</p><p>${entry.attendee_count} ${entry.attendee_count === 1 ? 'attendee' : 'attendees'}</p>`
      : `<p>${E(entry.deal_name || '')}</p><p>${entry.type === 'task' ? 'Task due' : 'Recorded date'} ${E(dayLabel(entry.day))}</p>${entry.owner ? `<p>${E(({joe: 'Joe', dell: 'Dell'})[entry.owner] || entry.owner)}</p>` : ''}<a class="home-outline" href="/deals?deal=${encodeURIComponent(entry.deal_id)}">Open deal</a>`;
    dialog.innerHTML = `<header class="home-panel-head"><h2 id="homeWeekDetailTitle">${E(entry.label)}</h2><button type="button" class="home-outline" data-home-week-close>Close</button></header><p><time datetime="${E(entry.start || entry.day)}">${E(date)}</time></p>${facts}`;
    dialog.querySelector('[data-home-week-close]').onclick = () => close();
    dialog.showModal();
    return true;
  };
  return { html, click, clear() { entries.clear(); selected = null; openerKey = null; if (dialog.open) dialog.close(); dialog.replaceChildren(); }, dispose() { closed(); dialog.remove(); entries.clear(); } };
}
