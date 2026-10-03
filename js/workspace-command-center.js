import { mountPastClientWidget } from './lease-radar.js';
import { createLeaseRadarClient } from './lease-radar-client.js';
import { leaseRadarFixture } from './lease-radar-fixture.js';
import { projectInvoices, invoiceHref, invoiceMoney, invoiceDate } from './invoice-tracker-model.js';
import { introductionSuggestions } from './relationship-network-model.js';
import { mountRelationshipDialog } from './relationship-dialog.js';
import { mountAutoRefresh, readWithDeadline, updatedLabel } from './auto-refresh.mjs';
import { createFixtureClient } from './fixture-client.js';
import { createLiveClient } from './live-client.js';
import { createLeadBoardClient } from './leads-client.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { localToday } from './calendar-model.js';
import { agendaSnapshot, controlSnapshot, dealHref, dealSnapshot, HOME_SCOPES, readHomeDashboard, topNewLeads } from './home-dashboard-model.js';
import { mountNotificationBadge } from './shell.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const E = escapeHtml;
const count = value => value === null ? '—' : String(value);
const dateLabel = day => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function mountHomeDashboard({ document, window, client, now = () => Date.now(), intervalMs = 30_000 }) {
  const $ = id => document.getElementById(id);
  const relationshipDialog = $('homeIntroductions') ? mountRelationshipDialog({document}) : null;
  let scope = 'team', snapshot = null, sequence = 0, updatedAt = null, disposed = false, leadEntries = new Map(), selectedLead = null;
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
  const render = () => {
    const signedOut = snapshot?.unauthorized;
    const unavailable = Object.values(snapshot?.reads || {}).some(read => read.state === 'error');
    $('homeNotice').hidden = !signedOut && !unavailable;
    $('homeNotice').innerHTML = signedOut ? '<a href="/auth/login?return_to=%2F">Sign in</a>' : unavailable ? 'Some Home data is unavailable.' : '';
    const summary = signedOut ? null : dealSnapshot(snapshot?.board, scope);
    $('dealAttention').setAttribute('aria-busy', String(snapshot?.loading ?? true));
    $('dealCounts').innerHTML = `Active Deals: ${count(summary?.active ?? null)} <span>Deals in Market: ${count(summary?.inMarket ?? null)}</span> <span>National Account Deals: ${count(summary?.national ?? null)}</span>`;
    paint($('dealFlags'), summary ? (summary.flagged.length ? summary.flagged.map(deal => `<a class="home-flag" data-home-key="deal:${E(deal.id)}" href="${E(dealHref(deal.id))}"><span class="home-flag-light" aria-hidden="true"></span><div><strong>${E(deal.name)}</strong><span>${E(deal.next_step || deal.phase || 'Needs attention')}</span></div><span class="home-arrow" aria-hidden="true">↗</span></a>`).join('') : '<p class="home-empty">No deal flags</p>') : `<p class="home-empty">${signedOut ? 'Sign in to view deals' : snapshot?.reads?.board?.state === 'error' ? 'Deals unavailable' : 'Updating…'}</p>`);
    const today = localToday(new Date(now()));
    if ($('homeInvoices')) {
      const invoices = signedOut ? null : projectInvoices(snapshot?.invoices, { scope, today: localToday(new Date(now())) });
      const overdue = invoices?.filter(row => row.overdue) || [];
      const invoiceUnavailable = snapshot?.reads?.invoices?.state === 'error';
      widget('homeInvoices', overdue.length ? `<header class="home-panel-head"><h2>Invoice attention · ${overdue.length}</h2><a class="home-outline" href="/invoices">Invoices ↗</a></header><div class="home-flags">${overdue.map(row => `<a class="home-flag" data-home-key="invoice:${E(row.key)}" href="${E(invoiceHref(row.key))}"><span class="home-flag-light" aria-hidden="true"></span><div><strong>${E(row.name)}</strong><span>${E(invoiceMoney(row.amount))} · overdue since ${E(invoiceDate(row.due_on))}</span></div><span class="home-arrow" aria-hidden="true">↗</span></a>`).join('')}</div>` : invoiceUnavailable && !signedOut ? '<header class="home-panel-head"><h2>Invoice attention</h2></header><p class="home-empty">Invoices unavailable</p>' : null);
    }
    let agenda = null;
    try { if (!signedOut) agenda = agendaSnapshot(snapshot?.board, snapshot?.details || new Map(), { scope, today }); }
    catch { $('homeNotice').hidden = false; if (!signedOut) $('homeNotice').textContent = 'Calendar and tasks unavailable.'; }
    const calendar = agenda?.entries.length ? `<header class="home-panel-head"><h2>Calendar & tasks</h2><a data-home-key="calendar" class="home-icon-link" href="/calendar" aria-label="Open Calendar">↗</a></header><a class="home-calendar-link" data-home-key="week" href="/calendar" aria-label="Open full calendar"><div class="home-week">${agenda.week.map(({ day, entries }) => `<div class="home-day${day === today ? ' today' : ''}"><span>${new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}</span><strong>${Number(day.slice(-2))}</strong><div class="home-day-marks">${entries.slice(0, 4).map(entry => `<i class="${entry.type}" aria-hidden="true"></i>`).join('')}</div><span class="sr-only">${entries.length} deal dates and tasks</span></div>`).join('')}</div></a><div class="home-agenda">${agenda.upcoming.map(entry => `<a href="${E(entry.type === 'task' ? dealHref(entry.deal_id) : `/calendar?day=${entry.day}&d=${entry.day}`)}" data-home-key="agenda:${E(entry.key)}"><time datetime="${entry.day}">${dateLabel(entry.day)}</time><div><strong>${E(entry.label)}</strong><span>${E(entry.deal_name)}</span></div><span class="home-item-type">${entry.type === 'task' ? 'Task' : 'Date'}</span></a>`).join('')}</div>${(agenda.failed.length || agenda.undated.length) ? `<span class="home-partial">${snapshot?.loading ? 'Some dates are updating…' : 'Some dates unavailable or missing'}</span>` : ''}` : null;
    widget('homeCalendar', calendar);
    const control = signedOut ? null : controlSnapshot(snapshot?.control || {});
    widget('homeControl', control ? `<a class="home-control-link" data-home-key="control" href="/control-room"><header class="home-panel-head"><h2>Control room</h2><span aria-hidden="true">↗</span></header><div class="home-control-status ${control.attention ? 'attention' : 'clear'}"><svg class="home-radar" viewBox="0 0 140 140" aria-hidden="true"><circle cx="70" cy="70" r="56"/><circle cx="70" cy="70" r="36"/><path d="M70 14V126M14 70H126"/><circle class="radar-wave" cx="70" cy="70" r="48"/><circle class="radar-dot" cx="70" cy="70" r="8"/></svg><div><h3>${control.attention ? 'Needs attention' : 'No issues'}</h3><p>${E(control.line)}</p></div></div></a>` : null);
    const leads = signedOut ? [] : topNewLeads(snapshot?.leads, { scope, actor: snapshot?.board?.actor, now: now() });
    leadEntries = new Map(leads.map(lead => [lead.id, lead]));
    widget('homeLeads', leads.length ? `<header class="home-panel-head"><h2>New leads</h2><span class="home-period">7 days</span></header><svg class="home-lead-scores" viewBox="0 0 600 42" role="img" aria-label="Relative scores of the top new leads">${leads.map((lead, i) => `<rect class="score-track" x="${i * 200}" y="10" width="186" height="12" rx="6"/><rect x="${i * 200}" y="10" width="${Math.max(0, lead.score) / Math.max(1, ...leads.map(row => row.score)) * 186}" height="12" rx="6"/>`).join('')}</svg><div class="home-lead-list">${leads.map((lead, i) => `<button type="button" data-lead="${E(lead.id)}" data-home-key="lead:${E(lead.id)}" class="home-lead"><span class="home-lead-rank">${i + 1}</span><div><strong>${E(lead.name)}</strong><span>${E([lead.specialty, lead.city].filter(Boolean).join(' · '))}</span></div><span class="home-score"><b>${E(lead.score)}</b><small>Score</small></span></button>`).join('')}</div>` : null);
    if ($('homeIntroductions')) {
      const suggestions = signedOut ? [] : introductionSuggestions(snapshot?.relationships, {scope,actor:snapshot?.board?.actor,now:now()});
      widget('homeIntroductions', suggestions.length ? `<header class="home-panel-head"><h2>Suggested introductions</h2><a class="home-icon-link" href="/relationships" aria-label="Open relationships">↗</a></header><div class="relationship-intro-list">${suggestions.map(s=>`<button type="button" class="relationship-card" data-intro-node="${E(s.to)}" data-home-key="intro:${E(s.id)}"><span class="intro-route">${E(s.fromNode.name)} → ${E(s.toNode.name)}</span><strong>${E(s.reason)}</strong></button>`).join('')}</div>` : null);
      if (signedOut || snapshot?.reads?.relationships?.state === 'error') relationshipDialog.clear();
      else if(snapshot?.relationships) relationshipDialog.update(snapshot.relationships);
    }
    $('observedAt').textContent = signedOut ? 'Sign in' : unavailable ? (updatedAt ? `Partial · ${updatedLabel(updatedAt)}` : 'Unavailable') : updatedLabel(updatedAt);
    if (signedOut || snapshot?.reads?.leads?.state === 'error') $('homeDetail').close();
    if (selectedLead && snapshot?.leads) {
      const current = snapshot.leads.leads?.find(lead => lead.id === selectedLead);
      if (current) paintLeadDetail(current); else $('homeDetail').close();
    }
  };
  const refresh = async ({ signal } = {}) => {
    const epoch = ++sequence;
    const previous = snapshot;
    let latest = null;
    const project = result => {
      const view = { ...result, control: { ...result.control }, details: new Map(result.details) };
      for (const key of ['board', 'leads', 'invoices', 'relationships']) if (result.reads[key].state === 'loading') view[key] = previous?.[key] ?? null;
      for (const key of ['incidents', 'work', 'requests', 'resources', 'schedule']) if (result.reads[key].state === 'loading') view.control[key] = previous?.control[key] ?? null;
      for (const [id, detail] of previous?.details || []) if (result.reads.board.state === 'loading' || result.reads[id]?.state === 'loading') view.details.set(id, detail);
      return view;
    };
    if (snapshot) snapshot = { ...snapshot, loading: true };
    render();
    $('refreshHome').setAttribute('aria-busy', 'true');
    try {
      await readWithDeadline(innerSignal => readHomeDashboard(client, { signal: innerSignal, onUpdate: result => {
        if (disposed || epoch !== sequence || innerSignal.aborted) return;
        latest = result; snapshot = project(result); updatedAt = snapshot.board && !result.unauthorized ? result.updatedAt : null; render();
      } }), { signal, timeoutMs: 25_000 });
    } catch {
      if (epoch === sequence && !disposed && latest) {
        for (const read of Object.values(latest.reads)) if (read.state === 'loading') { read.state = 'error'; read.code = 'read_timeout'; }
      }
    }
    finally { if (epoch === sequence && !disposed) { if (latest) { latest.loading = false; snapshot = project(latest); } render(); $('refreshHome').setAttribute('aria-busy', 'false'); } }
  };
  const paintLeadDetail = lead => {
    const expanded = $('homeDetail').querySelector('details')?.open;
    const focused = $('homeDetail').contains(document.activeElement) ? document.activeElement.dataset.homeKey : null;
    const html = `<header class="home-panel-head"><h2 id="homeDetailTitle">${E(lead.name)}</h2><button type="button" class="home-refresh" data-home-key="detail:close" data-close-detail aria-label="Close details">×</button></header><div class="home-detail-summary"><span class="home-detail-score">${E(lead.score)}<small>Score</small></span><div><h3>${E(lead.specialty || 'New lead')}</h3><p>${E([lead.city, lead.state].filter(Boolean).join(' · '))}</p></div></div><details><summary data-home-key="detail:summary">Details</summary><dl><dt>Added</dt><dd>${E(new Date(lead.created_at).toLocaleDateString())}</dd><dt>Stage</dt><dd>${E(lead.stage_label || lead.stage || '—')}</dd><dt>Owner</dt><dd>${E(lead.owner_label || lead.owner || '—')}</dd></dl></details><a class="home-outline" data-home-key="detail:leads" href="/leads">Leads ↗</a>`;
    if ($('homeDetailBody').innerHTML === html) return;
    $('homeDetailBody').innerHTML = html;
    if (expanded) $('homeDetail').querySelector('details').open = true;
    $('homeDetail').querySelector('[data-close-detail]').onclick = () => $('homeDetail').close();
    if (focused) ([...$('homeDetail').querySelectorAll('[data-home-key]')].find(node => node.dataset.homeKey === focused) || $('homeDetail').querySelector('[data-close-detail]'))?.focus();
  };
  $('homeDetail').addEventListener('close', () => { selectedLead = null; });
  $('homeLeads').addEventListener('click', event => {
    const button = event.target.closest('[data-lead]');
    const lead = leadEntries.get(button?.dataset.lead);
    if (!lead) return;
    selectedLead = lead.id;
    paintLeadDetail(lead);
    $('homeDetail').showModal();
    $('homeDetail').querySelector('[data-close-detail]').onclick = () => $('homeDetail').close();
  });
  $('homeIntroductions')?.addEventListener('click',event=>{const button=event.target.closest('[data-intro-node]');if(button && snapshot?.relationships)relationshipDialog.open(snapshot.relationships,button.dataset.introNode,button);});
  const auto = mountAutoRefresh({ document, window, refresh, intervalMs });
  const expiry = window.setInterval(() => {
    if (snapshot?.relationships && Date.parse(snapshot.relationships.valid_until) <= now()) {
      snapshot.relationships = null;
      relationshipDialog?.clear();
      render();
      auto.refresh();
    }
  }, 1000);
  $('refreshHome').addEventListener('click', auto.refresh);
  const pastWidget = $('homePastClients') && client.readLeaseRadar ? mountPastClientWidget({document,window,client,host:$('homePastClients'),now:()=>new Date(now()),scope:()=>scope}) : null;
  const buttons = [...$('scopeSwitch').querySelectorAll('[data-scope]')];
  const select = value => { scope = value; pastWidget?.render(); buttons.forEach(button => { const selected = button.dataset.scope === scope; button.setAttribute('aria-pressed', String(selected)); button.classList.toggle('on', selected); }); render(); };
  buttons.forEach(button => {
    button.addEventListener('click', () => select(button.dataset.scope));
    button.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const other = HOME_SCOPES[1 - HOME_SCOPES.indexOf(scope)]; select(other); buttons.find(node => node.dataset.scope === other).focus(); });
  });
  auto.refresh();
  return { refresh: auto.refresh, dispose() { disposed = true; sequence++; window.clearInterval(expiry); auto.dispose(); relationshipDialog?.dispose(); pastWidget?.dispose(); } };
}

if (typeof document !== 'undefined' && document.getElementById('dealAttention')) {
  const boot = resolveDealroomBoot(location);
  const client = boot.mode === 'live' ? createLiveClient() : await createFixtureClient(boot.options);
  client.getLeadBoard = boot.mode === 'live' ? createLeadBoardClient().getLeadBoard : async () => ({ leads: [] });
  client.readLeaseRadar = boot.mode === 'live' ? createLeaseRadarClient().readLeaseRadar : async()=>leaseRadarFixture();
  mountHomeDashboard({ document, window, client });
  mountNotificationBadge(client);
}
