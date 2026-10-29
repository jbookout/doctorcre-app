import { createCurrentRead } from './current-read.mjs';
import { onDialogClosed } from './dialog-lifecycle.js';
import { dealHref } from './home-dashboard-model.js';
import { meetingDate, meetingTime } from './home-week.js';

const E = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const text = value => typeof value === 'string';
const instant = value => text(value) && Number.isFinite(Date.parse(value));
const nullableText = value => value == null || text(value);
const sourceLabels = { outlook_calendar: 'Outlook calendar', deal_suggestions: 'Possible deals', meeting_prep: 'Deal preparation' };
const valid = value => value && ['ready', 'empty', 'partial', 'unavailable'].includes(value.state)
  && Array.isArray(value.items) && (value.notes == null || Array.isArray(value.notes) && value.notes.every(text))
  && (value.observed_at == null || instant(value.observed_at))
  && value.items.every(item => item && text(item.title) && instant(item.start) && instant(item.end) && nullableText(item.location)
    && Array.isArray(item.possible_deals) && item.possible_deals.every(deal => deal && text(deal.id) && deal.id.trim() && text(deal.name)
      && (deal.prep?.state === 'unavailable' || deal.prep?.state === 'ready'
        && ['phase', 'next_step', 'next_date', 'last_touch', 'market'].every(key => nullableText(deal.prep[key])))));
const fact = (label, value) => `<dt>${label}</dt><dd>${E(value || 'Not recorded')}</dd>`;

function preparationHtml(section, timeZone) {
  const time = value => meetingTime(value, timeZone, true);
  const warnings = (section.notes || []).map(note => `<p class="home-meeting-warning">${E(note)}</p>`).join('');
  const sources = Object.entries(sourceLabels).filter(([key]) => section.sources?.[key]).map(([key, label]) => {
    const state = section.sources[key].state;
    return `<span>${label}: ${E(['ready', 'partial', 'unavailable', 'stale'].includes(state) ? state : 'unavailable')}</span>`;
  }).join(' · ');
  const observed = section.observed_at ? `<p>Calendar read from Outlook <time datetime="${E(section.observed_at)}">${E(time(section.observed_at))}</time></p>` : '';
  const rows = section.items.map(meeting => {
    const flags = [meeting.all_day && 'All day', meeting.schedule_conflict && 'Overlapping meetings. Check Outlook.', meeting.time_changed && 'Time changed. Check Outlook.'].filter(Boolean);
    const deals = meeting.possible_deals.map(deal => `<section class="meeting-prep-deal"><h4><a href="${E(dealHref(deal.id))}">${E(deal.name)}</a></h4>${deal.prep.state === 'ready'
      ? `<dl>${fact('Phase', deal.prep.phase)}${fact('Next step', deal.prep.next_step)}${fact('Next date', deal.prep.next_date)}${fact('Last touch', deal.prep.last_touch)}${fact('Market', deal.prep.market)}</dl>`
      : '<p>Preparation unavailable. Open the deal to check it.</p>'}</section>`).join('');
    const noDeals = section.sources?.deal_suggestions?.state === 'unavailable' ? 'Possible deals unavailable.' : 'No possible deals returned.';
    return `<article class="meeting-prep-meeting"><h3>${E(meeting.title)}</h3><p><time datetime="${E(meeting.start)}">${E(meeting.all_day ? meetingDate(meeting.start) : time(meeting.start))}</time> to <time datetime="${E(meeting.end)}">${E(meeting.all_day ? meetingDate(meeting.end) : time(meeting.end))}</time></p><p>${E(meeting.location || 'Place not provided')}</p>${flags.map(flag => `<p class="home-meeting-warning">${E(flag)}</p>`).join('')}<h4>Possible deals</h4>${deals || `<p>${noDeals}</p>`}</article>`;
  }).join('');
  return `${warnings}${observed}${sources ? `<p>${sources}</p>` : ''}${section.state === 'partial' ? '<p>Some meeting preparation is incomplete.</p>' : ''}${section.state === 'unavailable' ? '<p role="status">Meeting preparation unavailable</p>' : rows || `<p>${section.state === 'empty' ? 'No upcoming meetings' : 'No meetings returned'}</p>`}`;
}

export function mountMeetingPreparation({ document, window, client }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'home-detail meeting-preparation';
  dialog.setAttribute('aria-labelledby', 'meetingPreparationTitle');
  dialog.innerHTML = '<header class="home-panel-head"><h2 id="meetingPreparationTitle" tabindex="-1">Meeting preparation</h2><button type="button" class="home-refresh" data-prep-close aria-label="Close meeting preparation">×</button></header><p>Possible deals match attendee email addresses. These links are not confirmed meeting context or attendance.</p><div data-prep-content aria-live="polite"></div><button type="button" class="home-outline" data-prep-retry>Refresh preparation</button>';
  document.body.append(dialog);
  const content = dialog.querySelector('[data-prep-content]');
  const retry = dialog.querySelector('[data-prep-retry]');
  const reads = createCurrentRead({ clock: window });
  let trigger = null, timeZone;
  const clear = () => { reads.invalidate(); content.replaceChildren(); retry.disabled = false; };
  const close = onDialogClosed(dialog, () => {
    clear();
    if (trigger) (trigger.isConnected ? trigger : document.querySelector('[data-prepare-meetings]') || document.getElementById('homePrimaryAction'))?.focus();
    trigger = null;
  });
  const refresh = () => {
    content.innerHTML = '<p role="status">Loading meeting preparation…</p>';
    retry.disabled = true;
    return reads.run(({ signal }) => client.calendarMeetingPrep({ signal }), {
      success: value => {
        content.innerHTML = valid(value) ? preparationHtml(value, timeZone) : '<p role="status">Meeting preparation unavailable</p>';
        retry.disabled = false;
      },
      failure: error => {
        if ([401, 403].includes(error?.status)) { invalidate(); return; }
        content.innerHTML = '<p role="status">Meeting preparation unavailable</p>';
        retry.disabled = false;
      },
    });
  };
  function invalidate() { trigger = null; clear(); dialog.close(); }
  dialog.querySelector('[data-prep-close]').onclick = () => { clear(); dialog.close(); };
  retry.onclick = refresh;
  dialog.addEventListener('cancel', clear);
  window.addEventListener('doctorcre-session-invalidated', invalidate);
  return {
    open(button, selectedTimeZone) { timeZone = selectedTimeZone; trigger = button; clear(); if (!dialog.open) dialog.showModal(); dialog.querySelector('h2').focus(); return refresh(); },
    clear: invalidate,
    dispose() { reads.dispose(); close(); window.removeEventListener('doctorcre-session-invalidated', invalidate); dialog.close(); dialog.remove(); },
  };
}
