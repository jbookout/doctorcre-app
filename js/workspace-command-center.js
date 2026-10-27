import { scopedDeals } from './deal-review-model.js';
import {onDialogClosed} from './dialog-lifecycle.js';
import { pageDocContext, publishDocRead, selectDocRecord, setDocFilters } from './doc-context.js';
import { projectInvoices, invoiceHref, invoiceMoney, invoiceDate } from './invoice-tracker-model.js';
import { introductionSuggestions } from './relationship-network-model.js';
import { mountAutoRefresh, readWithDeadline, updatedLabel } from './auto-refresh.mjs';
import { homeClient } from './home-boot.js';
import { BUSINESS_TIME_ZONE } from './business-date.js';
import { mountCallOutcomes } from './call-outcomes.js';
import { localToday } from './calendar-model.js';
import { agendaSnapshot, dealHref, dealSnapshot, HOME_SCOPES, readHomeAgenda, readHomeDashboard, topNewLeads } from './home-dashboard-model.js';
import { mountNotificationBadge } from './shell.js';
import { mountHomeCallTasks } from './home-call-tasks.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const E = escapeHtml;
const count = value => value === null ? '—' : String(value);
const AGENDA_PREVIEW = 6;
const dateLabel = day => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function mountHomeDashboard({ document, window, client, now = () => Date.now(), intervalMs = 30_000 }) {
  const $ = id => document.getElementById(id);
  let emailQuality = null, emailReview = null, emailRetired = false, emailObserver = null;
  const retirePendingEmail = () => {
    emailRetired = true;
    emailObserver?.disconnect();
    for (const [id, title, view] of [['homeEmailQuality', 'Email proposal quality', emailQuality], ['homeEmailFollowups', 'Email follow-ups', emailReview]]) {
      if (view || !$(id)) continue;
      $(id).setAttribute('aria-busy', 'false');
      $(id).innerHTML = `<header class="home-panel-head"><h2>${title}</h2></header><p role="status">Sign in to view ${title.toLowerCase()}.</p>`;
    }
  };
  window.addEventListener('doctorcre-session-invalidated', retirePendingEmail);
  let snapshotDocObservedAt = null, calendar = null;
  // The relationship dialog and the past-client widget are secondary: they load
  // after the first data paint so they never compete with the deal flags.
  let relationshipDialog = null, pastWidget = null, secondaryRequested = false;
  let agendaExpanded = false, agendaView = 'all', nextRead = readHomeDashboard;
  let scope = 'team', snapshot = null, sequence = 0, updatedAt = null, disposed = false, leadEntries = new Map(), selectedLead = null;
  const callTasks = $('homeCallTasks') ? mountHomeCallTasks({ document, client, host: $('homeCallTasks'), onChanged: async () => {
    const before = sequence;
    await auto.refresh();
    if (!disposed && before === sequence) await auto.refresh();
  } }) : null;
  const docSources = [['board','getHomeAgenda'],['leads','getLeadBoard']];
  const docPayload = (source, view) => source === 'board' ? {deals:scopedDeals(view?.board,scope)}
    : (view?.leads ? {leads:topNewLeads(view.leads,{scope,actor:view.board?.actor,now:now()})} : null);
  const paint = (target, html) => {
    if (target.innerHTML === html) return;
    const key = target.contains(document.activeElement) ? document.activeElement?.dataset.homeKey : null;
    target.innerHTML = html;
    if (key) {
      const replacement = [...target.querySelectorAll('[data-home-key]')].find(node => node.dataset.homeKey === key);
      (replacement || $('homePrimaryAction')).focus();
    }
  };
  const widget = (id, html) => { const target = $(id); if (!html && target.contains(document.activeElement)) $('homePrimaryAction').focus(); target.hidden = !html; if (html) paint(target, html); };
  const renderMeetings = signedOut => {
    if (!$('homeMeetings')) return;
    const meetings = signedOut ? null : calendar;
    if (!meetings) { $('homeMeetings').replaceChildren(); widget('homeMeetings', null); return; }
    const failed = meetings.state === 'unavailable';
    const count = meetings.items.length;
    const header = `<header class="home-panel-head"><h2>Upcoming meetings</h2>${failed ? '<button type="button" class="home-refresh" data-retry-meetings aria-label="Retry meetings" title="Retry meetings">↻</button>' : `<span class="home-period">${count} ${count === 1 ? 'meeting' : 'meetings'}</span>`}</header>`;
    const warnings = (meetings.notes || []).map(note => `<p class="home-meeting-warning">${E(note)}</p>`).join('');
    const rows = meetings.items.map(meeting => {
      const time = new Date(meeting.start).toLocaleString(undefined, { timeZone: BUSINESS_TIME_ZONE, month: 'short', day: 'numeric', ...(meeting.all_day ? {} : { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) });
      const detail = `${meeting.location || 'Place not provided'} · ${meeting.attendee_count} ${meeting.attendee_count === 1 ? 'attendee' : 'attendees'}`;
      return `<div class="home-meeting"><time datetime="${E(meeting.start)}">${E(time)}${meeting.all_day ? ' · All day' : ''}</time><strong>${E(meeting.title)}</strong><span>${E(detail)}</span></div>`;
    }).join('');
    const content = failed ? `<p class="home-meeting-failure" role="status">Meetings unavailable</p>`
      : count ? `<div class="home-meetings">${rows}</div>` : `<p class="home-empty">${meetings.state === 'empty' ? 'No upcoming meetings' : 'No meetings returned'}</p>`;
    widget('homeMeetings', header + warnings + content);
  };
  const render = () => {
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
    catch { $('homeNotice').hidden = false; if (!signedOut) $('homeNotice').textContent = 'Calendar and tasks unavailable.'; }
    const summary = signedOut ? null : dealSnapshot(snapshot?.board, scope, agenda);
    $('dealAttention').setAttribute('aria-busy', String(snapshot?.loading ?? true));
    $('dealCounts').innerHTML = `<span>Active deals: <b>${count(summary?.active ?? null)}</b></span> <span>In market: <b>${count(summary?.inMarket ?? null)}</b></span> <span>National accounts: <b>${count(summary?.national ?? null)}</b></span> <span>Overdue local deals: <b>${count(summary?.flagged?.length ?? null)}</b></span>`;
    paint($('dealFlags'), summary?.flagged ? (summary.flagged.length ? summary.flagged.map(deal => `<a class="home-flag" data-home-key="deal:${E(deal.id)}" href="${E(dealHref(deal.id))}"><span class="home-flag-light" aria-hidden="true"></span><div><strong>${E(deal.name)}</strong><span>${E(deal.next_step || deal.phase || 'Needs attention')}</span></div><span class="home-arrow" aria-hidden="true">↗</span></a>`).join('') : '<p class="home-empty">No overdue local next steps</p>') : `<p class="home-empty">${signedOut ? 'Sign in to view deals' : snapshot?.reads?.board?.state === 'error' ? 'Deals unavailable' : summary ? 'Overdue local deals unavailable' : 'Updating…'}</p>`);
    if ($('homeInvoices')) {
      const invoices = signedOut ? null : projectInvoices(snapshot?.invoices, { scope, today: localToday(new Date(now())) });
      const overdue = invoices?.filter(row => row.overdue) || [];
      const invoiceUnavailable = snapshot?.reads?.invoices?.state === 'error';
      widget('homeInvoices', overdue.length ? `<header class="home-panel-head"><h2>Invoice attention · ${overdue.length}</h2><a class="home-outline" href="/invoices">Invoices <span aria-hidden="true">↗</span></a></header><div class="home-flags">${overdue.map(row => `<a class="home-flag" data-home-key="invoice:${E(row.key)}" href="${E(invoiceHref(row.key))}"><span class="home-flag-light" aria-hidden="true"></span><div><strong>${E(row.name)}</strong><span>${E(invoiceMoney(row.amount))} · overdue since ${E(invoiceDate(row.due_on))}</span></div><span class="home-arrow" aria-hidden="true">↗</span></a>`).join('')}</div>` : invoiceUnavailable && !signedOut ? '<header class="home-panel-head"><h2>Invoice attention</h2></header><p class="home-empty">Invoices unavailable</p>' : null);
    }
    const agendaDeals = scopedDeals(snapshot?.board, scope);
    const agendaLoading = !signedOut && (!snapshot || snapshot.reads.board?.state === 'loading');
    const agendaUnavailable = !agenda || (!agenda.entries.length && agenda.failed.length === agendaDeals?.length && agenda.failed.length > 0);
    const agendaPartial = agenda && (agenda.failed.length > 0 || agenda.undated.length > 0);
    const agendaItems = ({ all: agenda?.upcoming, today: agenda?.dueToday, overdue: agenda?.overdue })[agendaView] || [];
    const agendaMessage = signedOut ? 'Sign in to view calendar and tasks'
      : agendaLoading ? 'Updating calendar and tasks…'
      : agendaUnavailable ? 'Calendar and tasks unavailable'
      : agendaPartial ? 'Some dates unavailable or missing'
      : !agendaItems.length ? ({ all: 'No calendar dates or tasks', today: 'No dates or tasks due today', overdue: 'No overdue dates or tasks' })[agendaView] : '';
    const agendaRetry = !signedOut && !agendaLoading && (agendaUnavailable || agenda?.failed.length);
    $('homeCalendar').setAttribute('aria-busy', String(Boolean(agendaLoading)));
    const calendarContent = agenda?.entries.length ? `<a class="home-calendar-link" data-home-key="week" href="/calendar"><span class="sr-only">Open calendar</span><div class="home-week">${agenda.week.map(({ day, entries }) => `<div class="home-day${day === today ? ' today' : ''}"><span>${new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}</span><strong>${Number(day.slice(-2))}</strong><div class="home-day-marks">${entries.slice(0, 4).map(entry => `<i class="${entry.type}" aria-hidden="true"></i>`).join('')}</div><span class="sr-only">${entries.length} deal dates and tasks</span></div>`).join('')}</div></a><div id="homeAgenda" class="home-agenda">${(agendaExpanded ? agendaItems : agendaItems.slice(0, AGENDA_PREVIEW)).map(entry => `<a href="${E(entry.type === 'task' ? dealHref(entry.deal_id) : `/calendar?day=${entry.day}&d=${entry.day}`)}" data-home-key="agenda:${E(entry.key)}">${entry.day ? `<time datetime="${entry.day}">${dateLabel(entry.day)}</time>` : '<span class="home-agenda-date">No date</span>'}<div><strong>${E(entry.label)}</strong><span>${E(entry.deal_name)}</span>${entry.owner ? `<span>${E(({joe: 'Joe', dell: 'Dell'})[entry.owner] || entry.owner)}</span>` : ''}</div><span class="home-item-type">${entry.type === 'task' ? 'Task' : 'Date'}</span></a>`).join('')}</div>${!agendaExpanded && agendaItems.length > AGENDA_PREVIEW ? `<button type="button" class="home-outline home-agenda-more" data-home-key="agenda:show-all" data-agenda-show-all aria-controls="homeAgenda">Show all ${agendaItems.length}</button>` : ''}` : '';

    widget('homeCalendar', `<header class="home-panel-head"><h2>Calendar & tasks</h2><a data-home-key="calendar" class="home-icon-link" href="/calendar" aria-label="Open Calendar">↗</a></header>${agenda && !signedOut ? `<div class="scope-switch" role="group" aria-label="Agenda view">${[['all', 'All dates & tasks'], ['today', 'Today'], ['overdue', 'Overdue']].map(([value, label]) => `<button type="button" class="scope-option${agendaView === value ? ' on' : ''}" data-home-key="agenda:view:${value}" data-agenda-view="${value}" aria-pressed="${agendaView === value}">${label}</button>`).join('')}</div>` : ''}${calendarContent}${agendaMessage ? `<p class="home-empty" role="status">${agendaMessage}</p>` : ''}${agendaRetry ? `<button type="button" class="home-outline" data-home-key="agenda:retry" data-agenda-retry${snapshot?.loading ? ' disabled' : ''}>Retry calendar and tasks</button>` : ''}`);
    const leads = signedOut ? [] : topNewLeads(snapshot?.leads, { scope, actor: snapshot?.board?.actor, now: now() });
    leadEntries = new Map(leads.map(lead => [lead.id, lead]));
    widget('homeLeads', leads.length ? `<header class="home-panel-head"><h2>Recent arrivals</h2><span class="home-period">7 days</span><a class="home-outline" href="/leads">Prospecting queue</a></header><svg class="home-lead-scores" viewBox="0 0 600 42" role="img" aria-label="Relative scores of recent arrivals">${leads.map((lead, i) => `<rect class="score-track" x="${i * 200}" y="10" width="186" height="12" rx="6"/><rect x="${i * 200}" y="10" width="${Math.max(0, lead.score) / Math.max(1, ...leads.map(row => row.score)) * 186}" height="12" rx="6"/>`).join('')}</svg><div class="home-lead-list">${leads.map((lead, i) => `<button type="button" data-lead="${E(lead.id)}" data-home-key="lead:${E(lead.id)}" class="home-lead"><span class="home-lead-rank">${i + 1}</span><div><strong>${E(lead.name)}</strong><span>${E([lead.specialty, lead.city].filter(Boolean).join(' · '))}</span></div><span class="home-score"><b>${E(lead.score)}</b><small>Score</small></span></button>`).join('')}</div>` : null);
    if ($('homeIntroductions')) {
      const suggestions = signedOut ? [] : introductionSuggestions(snapshot?.relationships, {scope,actor:snapshot?.board?.actor,now:now()});
      widget('homeIntroductions', suggestions.length ? `<header class="home-panel-head"><h2>Suggested introductions</h2><a class="home-icon-link" href="/relationships" aria-label="Open relationships">↗</a></header><div class="relationship-intro-list">${suggestions.map(s=>`<button type="button" class="relationship-card" data-intro-node="${E(s.to)}" data-home-key="intro:${E(s.id)}"><span class="intro-route">${E(s.fromNode.name)} → ${E(s.toNode.name)}</span><strong>${E(s.reason)}</strong></button>`).join('')}</div>` : null);
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
    if (!agendaOnly) { void emailReview?.refresh(); void emailQuality?.refresh(); }
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
        if (snapshot.board) loadSecondary();
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
      } if (latest) { latest.loading = false; snapshot = project(latest); } render(); loadSecondary(); $('refreshHome').setAttribute('aria-busy', 'false'); } }
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
  $('homeCalendar').addEventListener('click', event => {
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
  $('homeIntroductions')?.addEventListener('click',event=>{const button=event.target.closest('[data-intro-node]');if(button && snapshot?.relationships)relationshipDialog?.open(snapshot.relationships,button.dataset.introNode,button);});
  const auto = mountAutoRefresh({ document, window, refresh, intervalMs });
  const expiry = window.setInterval(() => {
    if (snapshot?.relationships && Date.parse(snapshot.relationships.valid_until) <= now()) {
      snapshot.relationships = null;
      relationshipDialog?.clear();
      render();
      auto.poll();
    }
  }, 1000);
  const updateCalendar = event => {
    const value = event.detail;
    const valid = value && ['ready', 'empty', 'partial', 'unavailable'].includes(value.state)
      && Array.isArray(value.items) && (value.notes == null || Array.isArray(value.notes) && value.notes.every(note => typeof note === 'string'))
      && value.items.every(row => row && typeof row.title === 'string' && typeof row.start === 'string' && Number.isFinite(Date.parse(row.start))
        && (row.location == null || typeof row.location === 'string') && Number.isSafeInteger(row.attendee_count) && row.attendee_count >= 0);
    calendar = value == null ? null : valid ? value : { state: 'unavailable', items: [] };
    renderMeetings(snapshot?.unauthorized);
  };
  $('homeMeetings')?.addEventListener('click', event => { if (event.target.closest('[data-retry-meetings]')) document.dispatchEvent(new window.Event('doctorcre:refresh-brief-calendar')); });
  const clearCalendar = () => { calendar = null; renderMeetings(true); };
  document.addEventListener('doctorcre:brief-calendar', updateCalendar);
  document.dispatchEvent(new window.Event('doctorcre:request-brief-calendar'));
  window.addEventListener('doctorcre-session-invalidated', clearCalendar);
  $('refreshHome').addEventListener('click', () => { auto.refresh(); document.dispatchEvent(new window.Event('doctorcre:refresh-brief-calendar')); });
  function loadSecondary() {
    if (secondaryRequested) return;
    secondaryRequested = true;
    emailObserver = new window.IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        emailObserver.unobserve(entry.target);
        if (disposed || emailRetired) continue;
        if (entry.target.id === 'homeEmailQuality') import('./email-quality.js').then(({ mountEmailQuality }) => {
          if (disposed || emailRetired) return;
          emailQuality = mountEmailQuality({ container: entry.target, client });
          void emailQuality.refresh();
        });
        else import('./email-followups.js').then(({ mountEmailFollowups }) => {
          if (disposed || emailRetired) return;
          emailReview = mountEmailFollowups({ container: entry.target, client, onChange: () => {
            void emailQuality?.refresh(); nextRead = readHomeAgenda; auto.refresh();
          } });
          void emailReview.refresh();
        });
      }
    });
    if ($('homeEmailQuality') && client.getEmailProposalQuality) emailObserver.observe($('homeEmailQuality'));
    if ($('homeEmailFollowups') && client.listEmailProposals) emailObserver.observe($('homeEmailFollowups'));
    if ($('homeIntroductions')) import('./relationship-dialog.js').then(({ mountRelationshipDialog }) => {
      if (disposed) return;
      relationshipDialog = mountRelationshipDialog({document});
      render();
    });
    if ($('homePastClients') && client.readLeaseRadar) import('./lease-radar.js').then(({ mountPastClientWidget }) => {
      if (disposed) return;
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
  auto.refresh();
  return { refresh: auto.refresh, dispose() { disposed = true; sequence++; emailObserver?.disconnect(); window.removeEventListener('doctorcre-session-invalidated', retirePendingEmail); window.clearInterval(expiry); auto.dispose(); document.removeEventListener('doctorcre:brief-calendar', updateCalendar); window.removeEventListener('doctorcre-session-invalidated', clearCalendar); relationshipDialog?.dispose(); pastWidget?.dispose(); callTasks?.dispose(); emailReview?.dispose(); emailQuality?.dispose(); } };
}

if (typeof document !== 'undefined' && document.getElementById('dealAttention')) {
  const client = await homeClient;
  mountHomeDashboard({ document, window, client });
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
  const openCards = () => {
    const button = document.getElementById('callModeButton');
    if (button && !button.hidden) button.click();
    else toast('Open Call Mode on the Mac that recorded the call to decide them.');
  };
  if (outcomes && client.readCallOutcomes) mountCallOutcomes({ container: outcomes, client: () => client, toast, openCards }).refresh();
}
