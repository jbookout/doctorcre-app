import { createPageBudget } from './read-budget.mjs';
import { mountBriefQueues } from './brief-queues.js';
import { overnightCutoff } from './business-date.js';
import { toDay } from './calendar-model.js';
import { briefInstruction, briefSectionsHtml } from './morning-brief-sections.js';
import { briefPreferences } from './brief-preferences.js';
import { briefOwnerLabel, mountBriefOwnerFilter } from './brief-owner-filter.js';
import {onDialogClosed} from './dialog-lifecycle.js';
import { mountAutoRefresh, readWithDeadline, updatedLabel } from './auto-refresh.mjs';
import { escapeText } from './change-receipts.mjs';
import { entryDetailsHtml } from './entry-details.mjs';
import { localDay, normalizeBrief, morningBriefView } from './morning-brief-model.js';

const dueFormat = new Intl.DateTimeFormat('en-US', { timeZone:'UTC', weekday:'long', month:'short', day:'numeric', year:'numeric' });
const dueLabel = value => {
  const day = toDay(value);
  return day ? dueFormat.format(new Date(`${day}T00:00:00Z`)) : value;
};

export function mountMorningBrief({ document:root, window:win, getClient, intervalMs, now = () => new Date() }) {
  const dialog = root.createElement('dialog'); dialog.id = 'docMorningBrief'; dialog.className = 'morning-brief'; dialog.setAttribute('aria-labelledby','morningTitle');
  dialog.innerHTML = '<header><h2 id="morningTitle">Morning brief</h2><button id="morningClose" type="button" aria-label="Dismiss morning brief">×</button></header><div class="morning-toolbar"><button id="morningBack" type="button" hidden>← Morning brief</button><time id="morningUpdated">Updating…</time><button id="morningRefresh" type="button" aria-label="Refresh morning brief" title="Refresh morning brief">↻</button></div><div id="morningOwners"></div><div id="morningCoverage" role="status"></div><nav id="morningQueues" aria-label="Morning work queues"></nav><div id="morningContent"></div>';
  root.body.append(dialog);
  const $ = id => dialog.querySelector(`#${id}`) || root.getElementById(id), control = $('docMorning');
  let facts = null, calendar, viewOptions, readEpoch = 0, fresh = false;
  let client, view = null, sponsor = null, preferences, since, windowDay, events = [], cursor = null, disposed = false, selected = null, detailEpoch = 0, opener;
  let storage; try { storage = win.localStorage; } catch {}
  const render = () => {
    const updated = queues.active ? queues.updated : {observedAt:view?.observedAt};
    $('morningUpdated').textContent = updated.error ? 'Queue update unavailable' : updatedLabel(updated.observedAt);
    if (updated.observedAt) $('morningUpdated').dateTime = updated.observedAt; else $('morningUpdated').removeAttribute('datetime');
    $('morningCoverage').textContent = view ? view.unavailable.join(' · ') : 'Brief unavailable';
    queues.menu(facts);
    if (queues.active) dialog.dataset.queueOpen = ''; else delete dialog.dataset.queueOpen;
    $('morningOwners').hidden = queues.active;
    if (queues.active) {
      const label = queues.label, count = queues.countLine;
      if (label) $('morningTitle').textContent = count ? `${label} · ${count}` : label;
      return;
    }
    if (selected) return;
    const title = view ? `Morning brief · ${view.sponsor === 'joe' ? 'Joe' : 'Dell'}` : 'Morning brief';
    $('morningTitle').textContent = title;
    $('morningBack').hidden = true;
    const empty = view && !view.unavailable.length ? `<section><p>${owners.current() === 'all' ? 'No selected priority cards' : `No selected priority cards for ${owners.current() === 'joe' ? 'Joe' : 'Dell'}`}</p>${owners.current() !== 'all' ? '<button type="button" data-brief-show-all>Show all</button>' : ''}</section>` : '';
    const cards = view?.groups.map(({label,row},index) => `<section><h3>${label}</h3><button type="button" class="morning-card" data-urgency="${row.due && row.due < localDay(now()) ? 'overdue' : 'today'}" data-brief-record="${index}" data-brief-key="${escapeText(row.key)}"><span class="morning-marker" aria-hidden="true">${index === 0 ? '↗' : '◇'}</span><div><strong>${escapeText(row.title)}</strong>${briefOwnerLabel(row) ? `<small class="morning-owner">${briefOwnerLabel(row)}</small>` : ''}${row.summary ? `<span>${escapeText(row.summary)}</span>` : ''}${row.due ? `<time datetime="${escapeText(row.due)}">Due ${escapeText(dueLabel(row.due))}</time>` : ''}</div><span aria-hidden="true">↗</span></button></section>`).join('') || empty;
    const html = cards + (view ? briefSectionsHtml(view.coverage) : '');
    if ($('morningContent').innerHTML !== html) {
      const focus = root.activeElement?.dataset.briefKey;
      const expanded = [...$('morningContent').querySelectorAll('[data-brief-section][open]')].map(node => node.dataset.briefSection);
      const focusedSection = root.activeElement?.closest('[data-brief-section]')?.dataset.briefSection;
      $('morningContent').innerHTML = html;
      for (const node of $('morningContent').querySelectorAll('[data-brief-section]')) {
        node.open = expanded.includes(node.dataset.briefSection);
        if (node.dataset.briefSection === focusedSection) node.querySelector('summary').focus();
      }
      if (focus !== undefined) focusCard(focus);
    }
  };
  const owners = mountBriefOwnerFilter(root, $('morningOwners'), () => {
    selected = null; ++detailEpoch;
    view = facts ? morningBriefView(facts, {...viewOptions, owner:owners.current()}) : null;
    render();
  });
  const cue = () => {
    const unseen = !!(view && preferences && preferences.value.day !== localDay(now()));
    const doc = $('docOpen');
    doc?.toggleAttribute('data-brief-unseen', unseen);
    if (unseen) doc?.setAttribute('aria-description', 'Morning brief ready'); else doc?.removeAttribute('aria-description');
    control.textContent = unseen ? 'Morning brief · new today' : 'Morning brief';
  };
  const remember = () => { if (preferences && view) preferences.save({ day:localDay(now()), lastShownAt:now().toISOString(), since }); cue(); };
  const close = () => { dialog.close(); };
  const open = async () => {
    opener = root.activeElement;
    const doc = $('docDetail'); if (doc?.open) doc.close();
    const pending = auto.revalidate();
    if (!dialog.open) dialog.showModal();
    const queuesReady = queues.prepare().catch(() => {});
    await pending;
    await queuesReady;
    if (!disposed) queues.menu(facts);
    if (dialog.open && sponsor && view) remember();
  };
  const focusCard = key => ([...$('morningContent').querySelectorAll('[data-brief-key]')].find(node => node.dataset.briefKey === key) || $('morningClose')).focus();
  const back = () => { queues.reset(); const key = selected?.key; selected = null; ++detailEpoch; render(); focusCard(key); };
  const publishCalendar = value => { calendar = value; root.dispatchEvent(new win.CustomEvent('doctorcre:brief-calendar', { detail: value })); };
  const clear = () => { queues.reset(); ++detailEpoch; selected = null; view = null; facts = null; sponsor = null; preferences = null; since = null; events = []; cursor = null; render(); cue(); };
  const suspend = () => { ++readEpoch; fresh = true; clear(); };
  const invalidate = () => { suspend(); publishCalendar(null); };
  const showRecord = async (row, { background = false } = {}) => {
    selected = row; const epoch = ++detailEpoch, owner = sponsor;
    $('morningBack').hidden = false; $('morningTitle').textContent = row.title;
    if (!background) { $('morningBack').focus(); $('morningContent').innerHTML = '<span class="morning-pending" role="status">Updating…</span>'; }
    try {
      const value = await readWithDeadline(() => row.kind === 'action' ? {action:row.action} : row.kind === 'deal' ? client.getDeal(row.id) : client.readLoop({ number:row.id,kind:row.loopKind }));
      if (disposed || epoch !== detailEpoch || owner !== sponsor) return;
      const record = row.kind === 'action' ? value?.action : row.kind === 'deal' ? value?.deal : value?.loop;
      if (!record || (row.kind === 'loop' ? String(record.number) !== row.id || record.kind !== row.loopKind : record.id !== row.id)) throw new Error('Invalid record');
      $('morningTitle').textContent = record.name || record.title || record.subject_name || row.title;
      const facts = row.kind === 'deal' ? [['Next step',row.action ? row.action.what : record.next_step],['Due',row.action ? row.action.due_on : record.next_date],['Phase',record.phase]] : row.kind === 'action' ? [['For',record.subject_name],['Reference',record.subject_ref],['Due',record.due_on],['Owner',record.owner]] : [['Due',record.due_on],['Status',record.status === 'open' ? null : record.status],['Your task',briefInstruction($('morningTitle').textContent,record.blocker_detail)]];
      const entries = row.kind === 'deal' ? value.thread || [] : [{ id:row.key, text:row.kind === 'action' ? record.what : record.body }];
      const expanded = [...$('morningContent').querySelectorAll('details[open]')].map(node => node.dataset.entry);
      const focusedEntry = root.activeElement?.closest('details')?.dataset.entry;
      const html = `<div class="morning-record"><dl>${facts.filter(([,value]) => value).map(([label,value]) => `<div><dt>${label}</dt><dd>${escapeText(label === 'Due' ? dueLabel(value) : value)}</dd></div>`).join('')}</dl><section>${entries.filter(entry => entry.text).slice(0,5).map(entry => `<article>${entryDetailsHtml(entry.text).replace('<details>',`<details${entry.id ? ` data-entry="${escapeText(entry.id)}"` : ''}>`)}</article>`).join('')}</section></div>`;
      if ($('morningContent').innerHTML !== html) {
        $('morningContent').innerHTML = html;
        const details = [...$('morningContent').querySelectorAll('details')];
        for (const detail of details) if (detail.dataset.entry !== undefined && expanded.includes(detail.dataset.entry)) detail.open = true;
        if (focusedEntry !== undefined) (details.find(detail => detail.dataset.entry === focusedEntry)?.querySelector('summary') || $('morningBack')).focus();
      }
    } catch (error) {
      if (disposed || epoch !== detailEpoch || owner !== sponsor) return;
      if ([401,403].includes(error.status)) invalidate();
      if (epoch === detailEpoch && !disposed) $('morningContent').innerHTML = '<span role="status">Record unavailable</span>';
    }
  };
  const refresh = async ({signal} = {}) => {
    const epoch = readEpoch;
    const current = () => !disposed && !signal?.aborted && epoch === readEpoch;
    if (dialog.open) queues.prepare().catch(() => {});
    try {
      if (!current()) return;
      client ||= await getClient();
      if (!current()) return;
      const freshRead = fresh; fresh = false;
      const payload = normalizeBrief(await readWithDeadline(() => client.morningBrief({signal, fresh:freshRead}), {signal}));
      if (!current()) return;
      if (!payload) throw new Error('Invalid brief');
      if (sponsor !== payload.sponsor || windowDay !== localDay(now())) {
        clear(); sponsor = payload.sponsor; preferences = briefPreferences(storage,sponsor); windowDay = localDay(now()); owners.setViewer(sponsor);
        const currentDay = localDay(now());
        if (preferences.value.day === currentDay && Number.isFinite(Date.parse(preferences.value.since))) since = preferences.value.since;
        else if (Number.isFinite(Date.parse(preferences.value.lastShownAt))) since = preferences.value.lastShownAt;
        else since = overnightCutoff(now());
      }
      let caughtUp = false;
      try {
        const takePage = createPageBudget();
        // eslint-disable-next-line no-restricted-syntax -- Brief change catch-up stops after four pages and calls takePage before each read.
        for (let page=0; page<4; page++) {
          takePage();
          const changes = await readWithDeadline(() => client.getChanges(cursor,{signal,since}),{signal});
          if (!Array.isArray(changes?.events)) throw new Error('Invalid changes');
          if (!current()) return;
          const ids = new Set(events.map(event => event.id));
          events = [...events,...changes.events.filter(event => !ids.has(event.id))].filter(event => Date.parse(event.recorded_at) >= Date.parse(since));
          cursor = changes.cursor ?? cursor;
          // An empty page establishes completion for this refresh only. A
          // previous poll's completion says nothing about new oldest-first pages.
          if (changes.events.length === 0) { caughtUp = true; break; }
        }
      } catch (error) {
        if ([401,403].includes(error.status)) throw error;
      }
      if (!current()) return;
      publishCalendar(payload.sections.calendar);
      facts = payload; viewOptions = { now:now(),since,events,caughtUp };
      const next = morningBriefView(facts,{...viewOptions, owner:owners.current()});
      view = next; render();
      if (dialog.open && preferences.value.day !== localDay(now())) remember(); else cue();
      if (selected) {
        const source = payload.sections[selected.action ? 'today' : selected.kind === 'deal' ? 'deals' : 'loops'];
        const admitted = source.state !== 'unavailable' && source.items.find(row => selected.kind === 'loop' ? String(row.number) === selected.id && row.kind === selected.loopKind : row.id === (selected.action?.id || selected.id) && (selected.kind !== 'action' || ['next_action','post_call_action','critical_date'].includes(row.item_kind)));
        if (admitted) await showRecord(selected.action ? {...selected,action:admitted} : selected,{background:true}); else back();
      }
    } catch (error) { if (current()) { if ([401,403].includes(error.status)) invalidate(); else { clear(); publishCalendar({ state: 'unavailable' }); } } }
  };
  const queues = mountBriefQueues({menu:$('morningQueues'),content:$('morningContent'),getClient:()=>client,getSponsor:()=>sponsor,
    onOpen:title=>{selected=null;++detailEpoch;$('morningTitle').textContent=title;$('morningBack').hidden=false;$('morningOwners').hidden=true;},onBack:back,onInvalidate:invalidate,onChange:render});
  const auto = mountAutoRefresh({ document:root,window:win,refresh,onResume:suspend,onWake:suspend,intervalMs });
  const refreshCalendar = () => auto.refresh();
  const currentCalendar = () => publishCalendar(calendar);
  root.addEventListener('doctorcre:request-brief-calendar', currentCalendar);
  root.addEventListener('doctorcre:refresh-brief-calendar', refreshCalendar);
  win.addEventListener('doctorcre-session-invalidated', invalidate);
  control.onclick = open;
  $('morningClose').onclick = close;
  // A modal that replaced the brief (Doc's command bar) already owns focus.
  onDialogClosed(dialog, () => { queues.reset(); ++detailEpoch; selected = null; if (root.querySelector('dialog[open]')) return; (opener?.isConnected && !opener.closest('dialog:not([open])') ? opener : $('docOpen'))?.focus(); });
  $('morningBack').onclick = back;
  $('morningRefresh').onclick = () => queues.active ? queues.refresh() : auto.refresh();
  $('morningContent').onclick = event => { if(queues.click(event))return; if (event.target.closest('[data-brief-show-all]')) { owners.setOwner('all'); $('morningOwners').querySelector('[data-brief-owner="all"]').focus(); return; } const link = event.target.closest('[data-brief-record]'); if (!link) return; event.preventDefault(); const row = view?.groups[Number(link.dataset.briefRecord)]?.row; if (row) showRecord(row); };
  const hidden = () => { if (root.visibilityState === 'hidden') suspend(); };
  // eslint-disable-next-line no-restricted-syntax -- Hidden-state listener suspends private brief content once per event; zero HTTP reads.
  root.addEventListener('visibilitychange',hidden);
  auto.refresh();
  return { open, refresh:auto.refresh, dispose() { if (disposed) return; disposed = true; queues.dispose(); ++detailEpoch; auto.dispose(); owners.dispose(); root.removeEventListener('doctorcre:refresh-brief-calendar', refreshCalendar); root.removeEventListener('doctorcre:request-brief-calendar', currentCalendar); win.removeEventListener('doctorcre-session-invalidated', invalidate); root.removeEventListener('visibilitychange',hidden); dialog.remove(); } };
}
