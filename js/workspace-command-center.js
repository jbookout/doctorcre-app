import { mountLocalTicker } from './visibility-poll.mjs';
import { workCard } from './work-card.js';
import { renderDealAlert } from './deal-items.js';
import { scopedDeals } from './deal-review-model.js';
import {onDialogClosed} from './dialog-lifecycle.js';
import { pageDocContext, publishDocRead, selectDocRecord, setDocFilters } from './doc-context.js';
import { projectInvoices, invoiceHref, invoiceMoney, invoiceDate } from './invoice-tracker-model.js';
import { introductionSuggestions, introductionRouteLabel } from './relationship-network-model.js';
import { mountAutoRefresh, readWithDeadline, updatedLabel } from './auto-refresh.mjs';
import { BUSINESS_TIME_ZONE } from './business-date.js';
import { mountCallOutcomes } from './call-outcomes.js';
import { localToday } from './calendar-model.js';
import { agendaSnapshot, dealHref, dealSnapshot, HOME_SCOPES, readHomeAgenda, readHomeDashboard, topNewLeads } from './home-dashboard-model.js';
import { mountNotificationBadge } from './shell.js';
import { mountHomeCallTasks } from './home-call-tasks.js';
import { mountHomeWeek } from './home-week-view.js';
import { meetingDate, meetingTime } from './home-week.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const E = escapeHtml;
const count = value => value === null ? '—' : String(value);
const AGENDA_PREVIEW = 6;
const MEETING_TIME_ZONES = [
  [BUSINESS_TIME_ZONE, 'Chicago (Central)'], ['America/New_York', 'New York (Eastern)'],
  ['America/Denver', 'Denver (Mountain)'], ['America/Los_Angeles', 'Los Angeles (Pacific)'], ['UTC', 'UTC'],
];
const dateLabel = day => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function mountHomeDashboard({ document, window, client, now = () => Date.now(), intervalMs }) {
  const flagKeydown = event => { if (event.key === ' ' && event.target.matches('#dealFlags .deal-alert h3 a')) { event.preventDefault(); event.target.click(); } };
  document.addEventListener('keydown', flagKeydown);
  const $ = id => document.getElementById(id);
  const workingWeek = mountHomeWeek({ document, host: $('homeCalendar') });
  let emailReview = null, replyOutcomes = null, emailFilings = null, emailRetired = false, panelObserver = null, emailInitialRead = Promise.resolve();
  const retirePendingEmail = () => {
    emailRetired = true;
    panelObserver?.disconnect();
    for (const [id, title, view] of [['homeReplyOutcomes', 'Sent replies', replyOutcomes], ['homeEmailFollowups', 'Email follow-ups', emailReview], ['homeEmailFilings', 'Filed automatically', emailFilings]]) {
      if (view || !$(id)) continue;
      $(id).setAttribute('aria-busy', 'false');
      $(id).innerHTML = `<header class="home-panel-head"><h2>${title}</h2></header><p role="status">Sign in to view ${title.toLowerCase()}.</p>`;
    }
  };
  window.addEventListener('doctorcre-session-invalidated', retirePendingEmail);
  let snapshotDocObservedAt = null, calendar = null, meetingPrep = null, prepEpoch = 0;
  let relationshipDialog = null, pastWidget = null, secondaryRequested = false;
  let agendaExpanded = false, agendaView = 'all', nextRead = readHomeDashboard, meetingTimeZone = BUSINESS_TIME_ZONE;
  let scope = 'team', snapshot = null, sequence = 0, updatedAt = null, disposed = false, leadEntries = new Map(), selectedLead = null;
  const callTasks = $('homeCallTasks') ? mountHomeCallTasks({ document, client, host: $('homeCallTasks'),
    openReport: async (session, { signal }) => {
      const { mountGlobalCallMode } = await import('./global-call-mode.js');
      if (signal.aborted) return false;
      const call = await mountGlobalCallMode(document);
      if (signal.aborted) return false;
      return call.open({ session, signal });
    }, onChanged: async () => {
    const before = sequence;
    await auto.refresh();
    if (!disposed && before === sequence) await auto.refresh();
  } }) : null;
  let storage; try { storage = window.localStorage; } catch {}
  let meetingReviews = null, meetingReviewLoad = null;
  const docSources = [['board','getHomeAgenda'],['leads','getLeadBoard']];
  const docPayload = (source, view) => source === 'board' ? {deals:scopedDeals(view?.board,scope)}
    : (view?.leads ? {leads:topNewLeads(view.leads,{scope,actor:view.board?.actor,now:now()})} : null);
  const paint = (target, html) => {
    if (target.innerHTML === html) return;
    const key = target.contains(document.activeElement) ? document.activeElement?.dataset.homeKey : null;
    const dayScroll = new Map([...target.querySelectorAll('[data-home-week-date]')].map(day => [day.dataset.homeWeekDate, day.scrollTop]));
    const week = target.querySelector('.home-week');
    const day = week && [...week.querySelectorAll('[data-home-week-date]')].sort((a, b) => Math.abs(a.getBoundingClientRect().left - week.getBoundingClientRect().left) - Math.abs(b.getBoundingClientRect().left - week.getBoundingClientRect().left))[0]?.dataset.homeWeekDate;
    target.innerHTML = html;
    for (const node of target.querySelectorAll('[data-home-week-date]')) node.scrollTop = dayScroll.get(node.dataset.homeWeekDate) || 0;
    if (day) {
      const currentWeek = target.querySelector('.home-week');
      const currentDay = target.querySelector(`[data-home-week-date="${day}"]`);
      if (currentWeek && currentDay) currentWeek.scrollLeft += currentDay.getBoundingClientRect().left - currentWeek.getBoundingClientRect().left;
    }
    if (key) {
      const replacement = [...target.querySelectorAll('[data-home-key]')].find(node => node.dataset.homeKey === key);
      (replacement || $('homePrimaryAction')).focus();
    }
  };
  const widget = (id, html) => { const target = $(id); if (!html && target.contains(document.activeElement)) $('homePrimaryAction').focus(); target.hidden = !html; if (html) paint(target, html); };
  const renderMeetings = signedOut => {
    if (!$('homeMeetings')) return;
    const meetings = signedOut ? null : calendar;
    if (!meetingReviews && !meetingReviewLoad && $('homeMeetingReviews') && client.logActivity && meetings?.follow_up_reviews?.length) {
      meetingReviewLoad = import('./home-meeting-reviews.js').then(({ mountHomeMeetingReviews }) => {
        if (disposed || snapshot?.unauthorized) return;
        meetingReviews = mountHomeMeetingReviews({ document, client, host: $('homeMeetingReviews'), storage, now });
        renderMeetings(snapshot?.unauthorized);
      }).catch(() => {
        meetingReviewLoad = null;
        if (!disposed && !snapshot?.unauthorized) widget('homeMeetingReviews', '<p class="home-empty" role="status">Meeting follow-ups unavailable. Reload this page to try again.</p>');
      });
    }
    meetingReviews?.update({ calendar: meetings, deals: scopedDeals(snapshot?.board, 'team') || [], actor: snapshot?.board?.actor, signedOut: Boolean(signedOut) });
    if (!meetings) { $('homeMeetings').replaceChildren(); widget('homeMeetings', null); return; }
    const failed = meetings.state === 'unavailable';
    const count = meetings.items.length;
    const header = `<header class="home-panel-head"><h2>Upcoming meetings</h2>${client.calendarMeetingPrep ? '<button type="button" class="home-outline" data-prepare-meetings data-home-key="prepare-meetings">Prepare meetings</button>' : ''}${failed ? '<button type="button" class="home-refresh" data-retry-meetings aria-label="Retry meetings" title="Retry meetings">↻</button>' : `<span class="home-period">${count} ${count === 1 ? 'meeting' : 'meetings'}</span>`}</header>`;
    const warnings = (meetings.notes || []).map(note => `<p class="home-meeting-warning">${E(note)}</p>`).join('');
    const rows = meetings.items.map(meeting => {
      const time = meeting.all_day
        ? meetingDate(meeting.start)
        : meetingTime(meeting.start, meetingTimeZone, true);
      const detail = `${meeting.location || 'Place not provided'} · ${meeting.attendee_count} ${meeting.attendee_count === 1 ? 'attendee' : 'attendees'}`;
      return `<div class="home-meeting"><time datetime="${E(meeting.start)}">${E(time)}${meeting.all_day ? ' · All day' : ''}</time><strong>${E(meeting.title)}</strong><span>${E(detail)}</span></div>`;
    }).join('');
    const content = failed ? `<p class="home-meeting-failure" role="status">Meetings unavailable</p>`
      : count ? `<div class="home-meetings">${rows}</div>` : `<p class="home-empty">${meetings.state === 'empty' ? 'No upcoming meetings' : 'No meetings returned'}</p>`;
    widget('homeMeetings', header + (!failed && count ? `<p class="home-week-zone">Meeting times · ${E(meetingTimeZone)}</p>` : '') + warnings + content);
  };
  const renderCalendar = (agenda, today, signedOut) => {
    const agendaDeals = scopedDeals(snapshot?.board, scope);
    const agendaLoading = !signedOut && (!snapshot || snapshot.reads.board?.state === 'loading');
    const agendaUnavailable = !agenda || (!agenda.entries.length && agenda.failed.length === agendaDeals?.length && agenda.failed.length > 0);
    const agendaPartial = agenda && (agenda.failed.length > 0 || agenda.undated.length > 0);
    const agendaItems = ({ all: agenda?.upcoming, today: agenda?.dueToday, overdue: agenda?.overdue })[agendaView]?.filter(entry => entry.type === 'date') || [];
    const agendaMessage = signedOut ? 'Sign in to view calendar'
      : agendaLoading ? 'Updating calendar…'
      : agendaUnavailable ? 'Calendar unavailable'
      : agendaPartial ? 'Some dates unavailable or missing'
      : !agendaItems.length ? ({ all: 'No calendar dates', today: 'No dates due today', overdue: 'No overdue dates' })[agendaView] : '';
    const agendaRetry = !signedOut && !agendaLoading && (agendaUnavailable || agenda?.failed.length);
    $('homeCalendar').setAttribute('aria-busy', String(Boolean(agendaLoading)));
    const weekContent = !signedOut && (agenda || calendar && calendar.state !== 'unavailable') ? workingWeek.html({ agenda, calendar, today, timeZone: meetingTimeZone }) : '';
    if (!weekContent) workingWeek.clear();
    const timezoneControl = weekContent && ['ready', 'partial'].includes(calendar?.state) && calendar.items.some(meeting => !meeting.all_day) ? `<label class="home-meeting-zone">Meeting timezone<select data-meeting-timezone data-home-key="meeting-timezone">${MEETING_TIME_ZONES.map(([zone, label]) => `<option value="${zone}"${zone === meetingTimeZone ? ' selected' : ''}>${label}</option>`).join('')}</select></label>` : '';
    const calendarContent = timezoneControl + weekContent + (agenda?.entries.length ? `<div id="homeAgenda" class="home-agenda">${(agendaExpanded ? agendaItems : agendaItems.slice(0, AGENDA_PREVIEW)).map(entry => `<a href="${E(`/calendar?day=${entry.day}&d=${entry.day}`)}" data-home-key="agenda:${E(entry.key)}">${entry.day ? `<time datetime="${entry.day}">${dateLabel(entry.day)}</time>` : '<span class="home-agenda-date">No date</span>'}<div><strong>${E(entry.label)}</strong><span>${E(entry.deal_name)}</span>${entry.owner ? `<span>${E(({joe: 'Joe', dell: 'Dell'})[entry.owner] || entry.owner)}</span>` : ''}</div></a>`).join('')}</div>${!agendaExpanded && agendaItems.length > AGENDA_PREVIEW ? `<button type="button" class="home-outline home-agenda-more" data-home-key="agenda:show-all" data-agenda-show-all aria-controls="homeAgenda">Show all ${agendaItems.length}</button>` : ''}` : '');

    widget('homeCalendar', `<header class="home-panel-head"><h2>Calendar</h2><a data-home-key="calendar" class="home-icon-link" href="/calendar" aria-label="Open Calendar">↗</a></header>${agenda && !signedOut ? `<div class="scope-switch" role="group" aria-label="Agenda view">${[['all', 'All dates'], ['today', 'Today'], ['overdue', 'Overdue']].map(([value, label]) => `<button type="button" class="scope-option${agendaView === value ? ' on' : ''}" data-home-key="agenda:view:${value}" data-agenda-view="${value}" aria-pressed="${agendaView === value}">${label}</button>`).join('')}</div>` : ''}${calendarContent}${agendaMessage ? `<p class="home-empty" role="status">${agendaMessage}</p>` : ''}${agendaRetry ? `<button type="button" class="home-outline" data-home-key="agenda:retry" data-agenda-retry${snapshot?.loading ? ' disabled' : ''}>Retry calendar</button>` : ''}`);
  };
  const render = () => {
    replyOutcomes?.syncActor();
    emailReview?.update();
    const signedOut = snapshot?.unauthorized;
    callTasks?.update({ read: snapshot?.reads?.callTasks, tasks: snapshot?.callTasks, actor: snapshot?.board?.actor,
      scope, signedOut, busy: !snapshot || snapshot.loading || snapshot.reads.board?.state !== 'read' });
    const unavailable = Object.values(snapshot?.reads || {}).some(read => read.state === 'error');
    $('homeNotice').hidden = !signedOut && !unavailable;
    $('homeNotice').innerHTML = signedOut ? '<a href="/auth/login?return_to=%2F">Sign in</a>' : unavailable ? 'Some Home data is unavailable.' : '';
    const today = localToday(new Date(now()));
    renderMeetings(signedOut);
    let agenda = null;
    try { if (!signedOut) agenda = agendaSnapshot(snapshot?.board, snapshot?.details || new Map(), { scope, today }); }
    catch { $('homeNotice').hidden = false; if (!signedOut) $('homeNotice').textContent = 'Calendar unavailable.'; }
    const tasks = agenda?.briefTasks || [];
    const briefMessage = signedOut ? 'Sign in to view tasks' : !agenda && (!snapshot || snapshot.reads.board?.state === 'loading') ? 'Updating tasks…' : !agenda ? 'Tasks unavailable' : agenda.failed.length ? 'Some tasks unavailable' : !tasks.length ? 'No open tasks' : '';
    widget('homeBrief', `<header class="home-panel-head"><h2>Your brief</h2>${agenda && !signedOut && !agenda.failed.length ? `<span class="home-period">${tasks.length} open</span>` : ''}</header>${tasks.map(task => workCard({ className: 'home-brief-card', title: `<a data-home-key="brief:${E(task.key)}" href="${E(dealHref(task.deal_id))}">${E(task.label)}</a>`, meta: `${E(task.deal_name)}${task.owner ? ` · ${E(({ joe: 'Joe', dell: 'Dell' })[task.owner] || task.owner)}` : ''} · ${task.day ? `Due <time datetime="${E(task.day)}">${E(dateLabel(task.day))}</time>` : 'No due date'}` })).join('')}${briefMessage ? `<p class="home-empty" role="status">${briefMessage}</p>` : ''}`);
    const summary = signedOut ? null : dealSnapshot(snapshot?.board, scope, agenda);
    $('dealAttention').setAttribute('aria-busy', String(snapshot?.loading ?? true));
    $('dealCounts').innerHTML = `<span>Active deals: <b>${count(summary?.active ?? null)}</b></span> <span>In market: <b>${count(summary?.inMarket ?? null)}</b></span> <span>National accounts: <b>${count(summary?.national ?? null)}</b></span> <span>Overdue deals: <b>${count(summary?.flagged?.length ?? null)}</b></span>`;
    paint($('dealFlags'), summary?.flagged ? (summary.flagged.length ? summary.flagged.map(deal => renderDealAlert(deal, { today })).join('') : '<p class="home-empty">No overdue next steps</p>') : `<p class="home-empty">${signedOut ? 'Sign in to view deals' : snapshot?.reads?.board?.state === 'error' ? 'Deals unavailable' : summary ? 'Overdue deals unavailable' : 'Updating…'}</p>`);
    if ($('homeInvoices')) {
      const invoices = signedOut ? null : projectInvoices(snapshot?.invoices, { scope, today: localToday(new Date(now())) });
      const overdue = invoices?.filter(row => row.overdue) || [];
      const invoiceUnavailable = snapshot?.reads?.invoices?.state === 'error';
      widget('homeInvoices', overdue.length ? `<header class="home-panel-head"><h2>Invoice attention · ${overdue.length}</h2><a class="home-outline" href="/invoices">Invoices <span aria-hidden="true">↗</span></a></header><div class="home-flags">${overdue.map(row => `<a class="home-flag" data-home-key="invoice:${E(row.key)}" href="${E(invoiceHref(row.key))}"><span class="home-flag-light" aria-hidden="true"></span><div><strong>${E(row.name)}</strong><span>${E(invoiceMoney(row.amount))} · overdue since ${E(invoiceDate(row.due_on))}</span></div><span class="home-arrow" aria-hidden="true">↗</span></a>`).join('')}</div>` : invoiceUnavailable && !signedOut ? '<header class="home-panel-head"><h2>Invoice attention</h2></header><p class="home-empty">Invoices unavailable</p>' : null);
    }
    renderCalendar(agenda, today, signedOut);
    const leads = signedOut ? [] : topNewLeads(snapshot?.leads, { scope, actor: snapshot?.board?.actor, now: now() });
    leadEntries = new Map(leads.map(lead => [lead.id, lead]));
    widget('homeLeads', leads.length ? `<header class="home-panel-head"><h2>Recent arrivals</h2><span class="home-period">7 days</span><a class="home-outline" href="/leads">Prospecting queue</a></header><svg class="home-lead-scores" viewBox="0 0 600 42" role="img" aria-label="Relative scores of recent arrivals">${leads.map((lead, i) => `<rect class="score-track" x="${i * 200}" y="10" width="186" height="12" rx="6"/><rect x="${i * 200}" y="10" width="${Math.max(0, lead.score) / Math.max(1, ...leads.map(row => row.score)) * 186}" height="12" rx="6"/>`).join('')}</svg><div class="home-lead-list">${leads.map((lead, i) => `<button type="button" data-lead="${E(lead.id)}" data-home-key="lead:${E(lead.id)}" class="home-lead"><span class="home-lead-rank">${i + 1}</span><div><strong>${E(lead.name)}</strong><span>${E([lead.specialty, lead.city].filter(Boolean).join(' · '))}</span></div><span class="home-score"><b>${E(lead.score)}</b><small>Score</small></span></button>`).join('')}</div>` : null);
    if ($('homeIntroductions')) {
      const suggestions = signedOut ? [] : introductionSuggestions(snapshot?.relationships, {scope,actor:snapshot?.board?.actor,now:now()});
      widget('homeIntroductions', suggestions.length ? `<header class="home-panel-head"><h2>Suggested introductions</h2><a class="home-icon-link" href="/relationships" aria-label="Open relationships">↗</a></header><div class="relationship-intro-list">${suggestions.map(s=>`<button type="button" class="relationship-card" data-intro-node="${E(s.to)}" data-home-key="intro:${E(s.id)}"><span class="intro-route">${E(introductionRouteLabel(s.path))}</span><strong>${E(s.reason)}</strong></button>`).join('')}</div>` : null);
      if (signedOut || snapshot?.reads?.relationships?.state === 'error') relationshipDialog?.clear();
      else if(snapshot?.relationships) relationshipDialog?.update(snapshot.relationships);
    }
    $('observedAt').textContent = signedOut ? 'Sign in' : unavailable ? (updatedAt ? `Partial · ${updatedLabel(updatedAt)}` : 'Unavailable') : updatedLabel(updatedAt);
    if (signedOut || snapshot?.reads?.leads?.state === 'error') $('homeDetail').close();
    if (selectedLead && snapshot?.leads) {
      const current = snapshot.leads.leads?.find(lead => lead.id === selectedLead);
      if (current) paintLeadDetail(current); else $('homeDetail').close();
    }
  };
  const refresh = async ({ signal } = {}) => {
    const read = nextRead; nextRead = readHomeDashboard;
    const agendaOnly = read === readHomeAgenda;
    if (!agendaOnly) { void emailReview?.refresh(); if (emailActivity?.open) void replyOutcomes?.refresh(); }
    const currentDocSources = agendaOnly ? docSources.slice(0, 1) : docSources;
    const docTickets = new Map(currentDocSources.map(([key,method]) => [key,pageDocContext?.begin(method)]));
    const epoch = ++sequence;
    const previous = snapshot;
    let latest = null, clearedActor = false;
    const project = result => {
      const view = { ...result, details: new Map(result.details) };
      const actorChanged = agendaOnly && result.board && result.board.actor !== previous?.board?.actor;
      if (agendaOnly && !actorChanged) {
        const { board, details, reads, unauthorized, updatedAt, loading } = view;
        const preservedReads = { ...previous?.reads };
        delete preservedReads.board;
        Object.assign(view, previous, { board, details, reads: { ...preservedReads, ...reads }, unauthorized, updatedAt, loading });
      }
      if (agendaOnly) view.unauthorized ||= previous?.unauthorized;
      if (actorChanged && !clearedActor) {
        clearedActor = true;
        snapshotDocObservedAt = null;
        pageDocContext?.clear();
        relationshipDialog?.clear();
        selectedLead = null;
        $('homeDetail').close();
        $('homeDetailBody').replaceChildren();
      }
      for (const key of ['board', 'leads', 'invoices', 'relationships', 'callTasks']) if (result.reads[key]?.state === 'loading') view[key] = previous?.[key] ?? null;
      if (!actorChanged && result.reads.board.state === 'loading') view.details = new Map(previous?.details || []);
      return view;
    };
    if (snapshot) snapshot = { ...snapshot, loading: true, reads: { ...snapshot.reads, board: { state: 'loading' }, ...(!agendaOnly ? { callTasks: { state: 'loading' } } : {}) } };
    render();
    $('refreshHome').setAttribute('aria-busy', 'true');
    try {
      await readWithDeadline(innerSignal => read(client, { signal: innerSignal, onUpdate: result => {
        if (disposed || epoch !== sequence || innerSignal.aborted) return;
        latest = result; snapshot = project(result); updatedAt = snapshot.board && !result.unauthorized ? result.updatedAt : null; render();
        if (!snapshot.loading && snapshot.board && !secondaryRequested) void emailInitialRead.then(() => {
          if (disposed || emailRetired || !snapshot?.board || snapshot.loading) return;
          const grid = document.querySelector('.home-grid');
          if (grid) panelObserver.observe(grid);
        });
      } }), { signal, timeoutMs: 25_000 });
    } catch {
      if (epoch === sequence && !disposed && latest) {
        for (const read of Object.values(latest.reads)) if (read.state === 'loading') { read.state = 'error'; read.code = 'read_timeout'; }
      }
    }
    finally { if (epoch === sequence && !disposed) {
      if (latest?.unauthorized) { snapshotDocObservedAt=null; pageDocContext?.clear(); }
      else {
        snapshotDocObservedAt = latest?.updatedAt ? Date.parse(latest.updatedAt) : null;
        for (const [key] of currentDocSources) {
          const payload = docPayload(key,latest);
          if (latest?.reads?.[key]?.state === 'read') pageDocContext?.finish(docTickets.get(key),payload,{at:snapshotDocObservedAt});
          else pageDocContext?.fail(docTickets.get(key));
        }
      } if (latest) { latest.loading = false; snapshot = project(latest); } render(); $('refreshHome').setAttribute('aria-busy', 'false'); } }
  };
  const paintLeadDetail = lead => {
    const expanded = $('homeDetail').querySelector('details')?.open;
    const focused = $('homeDetail').contains(document.activeElement) ? document.activeElement.dataset.homeKey : null;
    const html = `<header class="home-panel-head"><h2 id="homeDetailTitle">${E(lead.name)}</h2><button type="button" class="home-refresh" data-home-key="detail:close" data-close-detail aria-label="Close details">×</button></header><div class="home-detail-summary"><span class="home-detail-score">${E(lead.score)}<small>Score</small></span><div><h3>${E(lead.specialty || 'New lead')}</h3><p>${E([lead.city, lead.state].filter(Boolean).join(' · '))}</p></div></div><details><summary data-home-key="detail:summary">Details</summary><dl><dt>Added</dt><dd>${E(new Date(lead.created_at).toLocaleDateString())}</dd><dt>Stage</dt><dd>${E(lead.stage_label || lead.stage || '—')}</dd><dt>Owner</dt><dd>${E(lead.owner_label || lead.owner || '—')}</dd></dl></details><a class="home-outline" data-home-key="detail:leads" href="/leads">Leads <span aria-hidden="true">↗</span></a>`;
    if ($('homeDetailBody').innerHTML === html) return;
    $('homeDetailBody').innerHTML = html;
    if (expanded) $('homeDetail').querySelector('details').open = true;
    $('homeDetail').querySelector('[data-close-detail]').onclick = () => $('homeDetail').close();
    if (focused) ([...$('homeDetail').querySelectorAll('[data-home-key]')].find(node => node.dataset.homeKey === focused) || $('homeDetail').querySelector('[data-close-detail]'))?.focus();
  };
  onDialogClosed($('homeDetail'), () => { selectedLead = null; selectDocRecord(null,null); });
  $('homeLeads').addEventListener('click', event => {
    const button = event.target.closest('[data-lead]');
    const lead = leadEntries.get(button?.dataset.lead);
    if (!lead) return;
    selectedLead = lead.id; selectDocRecord('lead', lead.id);
    paintLeadDetail(lead);
    $('homeDetail').showModal();
    $('homeDetail').querySelector('[data-close-detail]').onclick = () => $('homeDetail').close();
  });
  $('homeCalendar').addEventListener('change', event => {
    const choice = event.target.closest('[data-meeting-timezone]');
    if (!choice || !MEETING_TIME_ZONES.some(([zone]) => zone === choice.value)) return;
    meetingTimeZone = choice.value;
    render();
  });
  $('homeCalendar').addEventListener('click', event => {
    if (workingWeek.click(event)) return;
    const view = event.target.closest('[data-agenda-view]');
    if (view) {
      agendaView = view.dataset.agendaView;
      agendaExpanded = false;
      render();
      return;
    }
    if (event.target.closest('[data-agenda-retry]')) {
      if (snapshot?.loading || snapshot?.unauthorized) return;
      nextRead = readHomeAgenda;
      auto.refresh();
      return;
    }
    if (!event.target.closest('[data-agenda-show-all]')) return;
    agendaExpanded = true;
    render();
    $('homeAgenda')?.querySelectorAll('a')[AGENDA_PREVIEW]?.focus();
  });
  $('homeIntroductions')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-intro-node]');
    if (!button || !snapshot?.relationships) return;
    const actor = snapshot.board?.actor;
    const { mountRelationshipDialog } = await import('./relationship-dialog.js');
    if (disposed || snapshot?.unauthorized || !snapshot?.relationships || snapshot.board?.actor !== actor) return;
    relationshipDialog ||= mountRelationshipDialog({ document });
    relationshipDialog.open(snapshot.relationships, button.dataset.introNode, button);
  });
  const auto = mountAutoRefresh({ document, window, refresh, intervalMs });
  const expiry = mountLocalTicker({ document, window, intervalMs: 1000, tick: () => {
    if (snapshot?.relationships && Date.parse(snapshot.relationships.valid_until) <= now()) {
      snapshot.relationships = null;
      relationshipDialog?.clear();
      render();
      auto.poll();
    }
  } });
  const updateCalendar = event => {
    const value = event.detail;
    const valid = value && ['ready', 'empty', 'partial', 'unavailable'].includes(value.state)
      && Array.isArray(value.items) && (value.notes == null || Array.isArray(value.notes) && value.notes.every(note => typeof note === 'string'))
      && value.items.every(row => row && typeof row.title === 'string' && typeof row.start === 'string' && Number.isFinite(Date.parse(row.start))
        && (row.location == null || typeof row.location === 'string') && Number.isSafeInteger(row.attendee_count) && row.attendee_count >= 0);
    calendar = value == null ? null : valid ? value : { state: 'unavailable', items: [] };
    const today = localToday(new Date(now()));
    let agenda = null;
    try { if (!snapshot?.unauthorized) agenda = agendaSnapshot(snapshot?.board, snapshot?.details || new Map(), { scope, today }); } catch {}
    renderMeetings(snapshot?.unauthorized);
    renderCalendar(agenda, today, snapshot?.unauthorized);
  };
  $('homeMeetings')?.addEventListener('click', async event => {
    if (event.target.closest('[data-retry-meetings]')) document.dispatchEvent(new window.Event('doctorcre:refresh-brief-calendar'));
    const button = event.target.closest('[data-prepare-meetings]');
    if (!button || snapshot?.unauthorized || disposed) return;
    const epoch = prepEpoch;
    try {
      const { mountMeetingPreparation } = await import('./meeting-preparation.js');
      if (disposed || epoch !== prepEpoch) return;
      meetingPrep ||= mountMeetingPreparation({ document, window, client });
      meetingPrep.open(button, meetingTimeZone);
    } catch { if (!disposed && epoch === prepEpoch) { $('homeNotice').hidden = false; $('homeNotice').textContent = 'Meeting preparation unavailable. Try Prepare meetings again.'; } }
  });
  const clearCalendar = () => {
    prepEpoch++; sequence++; meetingPrep?.clear(); calendar = null; workingWeek.clear();
    snapshot = { unauthorized: true, loading: false, board: null, details: new Map(), reads: { board: { state: 'error' } } };
    updatedAt = null; snapshotDocObservedAt = null; pageDocContext?.clear();
    selectedLead = null; $('homeDetail').close(); $('homeDetailBody').replaceChildren(); relationshipDialog?.clear();
    render();
  };
  document.addEventListener('doctorcre:brief-calendar', updateCalendar);
  document.dispatchEvent(new window.Event('doctorcre:request-brief-calendar'));
  window.addEventListener('doctorcre-session-invalidated', clearCalendar);
  $('refreshHome').addEventListener('click', () => { auto.refresh(); document.dispatchEvent(new window.Event('doctorcre:refresh-brief-calendar')); });
  function loadSecondaryPanels() {
    if (secondaryRequested) return;
    secondaryRequested = true;
    if ($('homePastClients') && client.readLeaseRadar) import('./lease-radar.js').then(({ mountPastClientWidget }) => {
      if (disposed || emailRetired) return;
      pastWidget = mountPastClientWidget({document,window,client,host:$('homePastClients'),now:()=>new Date(now()),scope:()=>scope});
    });
  }
  const buttons = [...$('scopeSwitch').querySelectorAll('[data-scope]')];
  const select = value => {
    if (scope !== value) agendaExpanded = false;
    scope = value; setDocFilters({ scope }); pastWidget?.render();
    if (!snapshot?.unauthorized) for (const [key,method] of docSources) {
      if (snapshot?.reads?.[key]?.state === 'read') publishDocRead(method,docPayload(key,snapshot));
    }
    buttons.forEach(button => { const selected = button.dataset.scope === scope; button.setAttribute('aria-pressed', String(selected)); button.classList.toggle('on', selected); });
    render();
  };
  buttons.forEach(button => {
    button.addEventListener('click', () => select(button.dataset.scope));
    button.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const other = HOME_SCOPES[1 - HOME_SCOPES.indexOf(scope)]; select(other); buttons.find(node => node.dataset.scope === other).focus(); });
  });
  panelObserver = new window.IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      panelObserver.unobserve(entry.target);
      if (disposed || emailRetired) continue;
      if (entry.target.matches('.home-grid')) loadSecondaryPanels();
    }
  });
  const emailActivity = $('homeEmailActivity');
  const openEmailActivity = () => {
    if (!emailActivity.open || disposed || emailRetired) return;
    emailActivity.removeEventListener('toggle', openEmailActivity);
    if (client.listEmailProposals) import('./reply-outcomes.js').then(({ mountReplyOutcomes }) => {
      if (disposed || emailRetired) return;
      replyOutcomes = mountReplyOutcomes({ container: $('homeReplyOutcomes'), client });
      void replyOutcomes.refresh();
    });
    if ($('homeEmailFilings') && client.listEmailThreadFilings) import('./email-filings.js').then(({ mountEmailFilings }) => {
      if (disposed || emailRetired) return;
      emailFilings = mountEmailFilings({ container: $('homeEmailFilings'), client });
      void emailFilings.refresh();
    });
  };
  emailActivity?.addEventListener('toggle', openEmailActivity);
  if ($('homeEmailFollowups') && client.listEmailProposals) emailInitialRead = import('./email-followups.js').then(({ mountEmailFollowups }) => {
    if (disposed || emailRetired) return;
    emailReview = mountEmailFollowups({ container: $('homeEmailFollowups'), client, onChange: () => {
      if (emailActivity?.open) void replyOutcomes?.refresh(); nextRead = readHomeAgenda; auto.refresh();
    } });
    return emailReview.refresh();
  });
  auto.refresh();
  return { refresh: auto.refresh, dispose() { document.removeEventListener('keydown', flagKeydown); disposed = true; workingWeek.dispose(); sequence++; prepEpoch++; meetingPrep?.dispose(); panelObserver?.disconnect(); emailActivity?.removeEventListener('toggle', openEmailActivity); window.removeEventListener('doctorcre-session-invalidated', retirePendingEmail); expiry.dispose(); auto.dispose(); document.removeEventListener('doctorcre:brief-calendar', updateCalendar); window.removeEventListener('doctorcre-session-invalidated', clearCalendar); relationshipDialog?.dispose(); pastWidget?.dispose(); callTasks?.dispose(); meetingReviews?.dispose(); emailReview?.dispose(); emailFilings?.dispose(); replyOutcomes?.dispose(); } };
}

// Mounts the classic Home into `host` from the #classicHome template. The React
// Home calls this below the inbox; the page itself no longer runs it on load.
export function mountClassicHome({ document, window, client, host }) {
  host.replaceChildren(document.getElementById('classicHome').content.cloneNode(true));
  const dashboard = mountHomeDashboard({ document, window, client });
  // The inbox Home's brief reads its calendar only once this dashboard is here.
  document.dispatchEvent(new window.Event('doctorcre:refresh-brief-calendar'));
  mountNotificationBadge(client);
  const outcomes = document.getElementById('homeCallOutcomes');
  // The answer to an Undo or "Looks right" is shown briefly, then cleared,
  // unless something else has written to the notice since.
  const notice = document.getElementById('homeNotice');
  const toast = message => {
    notice.hidden = false; notice.textContent = message;
    setTimeout(() => { if (notice.textContent === message) { notice.textContent = ''; notice.hidden = true; } }, 6000);
  };
  // The cards still waiting are decided in Call Mode's post-call report.
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const openCards = async session => {
    try {
      const { mountGlobalCallMode } = await import('./global-call-mode.js');
      if (signal.aborted) return;
      const call = await mountGlobalCallMode(document);
      if (signal.aborted) return;
      if (!await call.open({ session, signal }) && !signal.aborted) toast('Open Call Mode on the Mac that recorded the call to decide them.');
    } catch {
      if (!signal.aborted) toast('The call report could not open. Try again on the Mac that recorded this call.');
    }
  };
  const callOutcomes = outcomes && client.readCallOutcomes ? mountCallOutcomes({ container: outcomes, client: () => client, toast, openCards }) : null;
  window.addEventListener('doctorcre-session-invalidated', () => { lifetime.abort(); callOutcomes?.dispose(); }, { once: true });
  callOutcomes?.refresh();
  return { dispose() { lifetime.abort(); callOutcomes?.dispose(); dashboard.dispose(); } };
}
