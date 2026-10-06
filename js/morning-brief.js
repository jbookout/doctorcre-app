import { mountAutoRefresh, readWithDeadline, updatedLabel } from './auto-refresh.mjs';
import { escapeText } from './change-receipts.mjs';
import { entryDetailsHtml } from './entry-details.mjs';
import { localDay, validBrief, morningBriefView, briefPreferences } from './morning-brief-model.js';
import { mountWeeklyUsage } from './weekly-usage.js';

export function mountMorningBrief({ document:root, window:win, getClient, automatic = true, intervalMs = 30_000, now = () => new Date() }) {
  const dialog = root.createElement('dialog'); dialog.id = 'docMorningBrief'; dialog.className = 'morning-brief'; dialog.setAttribute('aria-labelledby','morningTitle');
  dialog.innerHTML = '<header><div><span class="doc-orb" aria-hidden="true">◍</span><h2 id="morningTitle">Morning brief</h2></div><button id="morningClose" type="button" aria-label="Dismiss morning brief">×</button></header><div class="morning-toolbar"><button id="morningBack" type="button" hidden>← Morning brief</button><time id="morningUpdated">Updating…</time><button id="morningRefresh" type="button" aria-label="Refresh morning brief" title="Refresh morning brief">↻</button><button id="morningSpeech" type="button" aria-label="Brief speech" title="Brief speech" aria-pressed="false">◖))</button><button id="morningListen" type="button" aria-label="Listen to morning brief" title="Listen to morning brief" disabled>▶</button></div><div id="morningCoverage" role="status"></div><div id="morningContent"></div>';
  root.body.append(dialog);
  const usageHost = root.createElement('section'); usageHost.setAttribute('aria-label', 'Weekly feature use'); dialog.append(usageHost);
  const usage = mountWeeklyUsage({ host: usageHost, fetch: win.fetch?.bind(win) });
  const $ = id => dialog.querySelector(`#${id}`) || root.getElementById(id), control = $('docMorning');
  let client, view = null, sponsor = null, preferences, since, windowDay, events = [], cursor = null, disposed = false, selected = null, detailEpoch = 0, opener, speaking = false, speechEpoch = 0;
  let storage; try { storage = win.localStorage; } catch {}
  const speechAvailable = !!win.speechSynthesis && !!win.SpeechSynthesisUtterance;
  const stop = () => { const active = speaking; speaking = false; ++speechEpoch; if (active) win.speechSynthesis?.cancel(); $('morningListen').textContent = '▶'; $('morningListen').setAttribute('aria-label','Listen to morning brief'); };
  const controls = () => {
    const enabled = preferences?.value.speech === true;
    $('morningSpeech').setAttribute('aria-pressed',String(enabled)); $('morningSpeech').disabled = !speechAvailable || !sponsor;
    $('morningListen').disabled = !speechAvailable || !enabled || !view?.spoken || selected !== null;
  };
  const render = () => {
    $('morningUpdated').textContent = updatedLabel(view?.observedAt);
    if (view?.observedAt) $('morningUpdated').dateTime = view.observedAt; else $('morningUpdated').removeAttribute('datetime');
    $('morningCoverage').textContent = view ? view.unavailable.join(' · ') : 'Brief unavailable';
    controls();
    usageHost.hidden = selected !== null;
    if (selected) return;
    const title = view ? `Morning brief · ${view.sponsor === 'joe' ? 'Joe' : 'Dell'}` : 'Morning brief';
    $('morningTitle').textContent = title;
    $('morningBack').hidden = true;
    const html = view?.groups.map(({label,row},index) => `<section><h3>${label}</h3><button type="button" class="morning-card" data-urgency="${row.due && row.due < localDay(now()) ? 'overdue' : 'today'}" data-brief-record="${index}" data-brief-key="${escapeText(row.key)}"><span class="morning-marker" aria-hidden="true">${index === 0 ? '↗' : '◇'}</span><div><strong>${escapeText(row.title)}</strong>${row.summary ? `<span>${escapeText(row.summary)}</span>` : ''}${row.due ? `<time datetime="${escapeText(row.due)}">Due ${escapeText(row.due)}</time>` : ''}</div><span aria-hidden="true">↗</span></button></section>`).join('') || '';
    if ($('morningContent').innerHTML !== html) {
      const focus = root.activeElement?.dataset.briefKey;
      $('morningContent').innerHTML = html;
      if (focus !== undefined) focusCard(focus);
    }
  };
  const remember = () => { if (preferences && view) preferences.save({ day:localDay(now()), lastShownAt:now().toISOString(), since }); };
  const close = () => { stop(); dialog.close(); };
  const open = () => {
    opener = root.activeElement;
    const doc = $('docDetail'); if (doc?.open) doc.close();
    selected = null; ++detailEpoch; stop(); render();
    if (!dialog.open) dialog.showModal();
    void usage.refresh();
    if (sponsor && view) {
      // Keep the current briefing window across page navigation. Only metadata
      // survives; every page must re-read the facts before opening its brief.
      remember();
    }
  };
  const focusCard = key => ([...$('morningContent').querySelectorAll('[data-brief-key]')].find(node => node.dataset.briefKey === key) || $('morningClose')).focus();
  const back = () => { const key = selected?.key; selected = null; ++detailEpoch; render(); focusCard(key); };
  const clear = () => { stop(); ++detailEpoch; selected = null; view = null; sponsor = null; preferences = null; since = null; events = []; cursor = null; render(); };
  const showRecord = async (row, { background = false } = {}) => {
    selected = row; const epoch = ++detailEpoch, owner = sponsor;
    stop(); controls(); $('morningBack').hidden = false; $('morningTitle').textContent = row.title;
    if (!background) { $('morningBack').focus(); $('morningContent').innerHTML = '<span class="morning-pending" role="status">Updating…</span>'; }
    try {
      const value = await readWithDeadline(() => row.kind === 'action' ? {action:row.action} : row.kind === 'deal' ? client.getDeal(row.id) : client.readLoop({ number:row.id,kind:row.loopKind }));
      if (disposed || epoch !== detailEpoch || owner !== sponsor) return;
      const record = row.kind === 'action' ? value?.action : row.kind === 'deal' ? value?.deal : value?.loop;
      if (!record || (row.kind === 'loop' ? String(record.number) !== row.id || record.kind !== row.loopKind : record.id !== row.id)) throw new Error('Invalid record');
      $('morningTitle').textContent = record.name || record.title || record.subject_name || row.title;
      const facts = row.kind === 'deal' ? [['Next step',record.next_step],['Due',record.next_date],['Phase',record.phase]] : row.kind === 'action' ? [['For',record.subject_name],['Reference',record.subject_ref],['Due',record.due_on],['Owner',record.owner]] : [['Due',record.due_on],['Status',record.status],['Blocker',record.blocker_detail]];
      const entries = row.kind === 'deal' ? value.thread || [] : [{ id:row.key, text:row.kind === 'action' ? record.what : record.body }];
      const expanded = [...$('morningContent').querySelectorAll('details[open]')].map(node => node.dataset.entry);
      const focusedEntry = root.activeElement?.closest('details')?.dataset.entry;
      const html = `<div class="morning-record"><dl>${facts.filter(([,value]) => value).map(([label,value]) => `<div><dt>${label}</dt><dd>${escapeText(value)}</dd></div>`).join('')}</dl><section>${entries.filter(entry => entry.text).slice(0,5).map(entry => `<article>${entryDetailsHtml(entry.text).replace('<details>',`<details${entry.id ? ` data-entry="${escapeText(entry.id)}"` : ''}>`)}</article>`).join('')}</section></div>`;
      if ($('morningContent').innerHTML !== html) {
        $('morningContent').innerHTML = html;
        const details = [...$('morningContent').querySelectorAll('details')];
        for (const detail of details) if (detail.dataset.entry !== undefined && expanded.includes(detail.dataset.entry)) detail.open = true;
        if (focusedEntry !== undefined) (details.find(detail => detail.dataset.entry === focusedEntry)?.querySelector('summary') || $('morningBack')).focus();
      }
    } catch (error) {
      if (disposed || epoch !== detailEpoch || owner !== sponsor) return;
      if ([401,403].includes(error.status)) clear();
      if (epoch === detailEpoch && !disposed) $('morningContent').innerHTML = '<span role="status">Record unavailable</span>';
    }
  };
  const refresh = async ({signal} = {}) => {
    try {
      client ||= await getClient();
      const payload = await readWithDeadline(() => client.morningBrief({signal}), {signal});
      if (disposed || signal?.aborted) return;
      if (!validBrief(payload)) throw new Error('Invalid brief');
      if (sponsor !== payload.sponsor || windowDay !== localDay(now())) {
        clear(); sponsor = payload.sponsor; preferences = briefPreferences(storage,sponsor); windowDay = localDay(now());
        const currentDay = localDay(now());
        if (preferences.value.day === currentDay && Number.isFinite(Date.parse(preferences.value.since))) since = preferences.value.since;
        else if (Number.isFinite(Date.parse(preferences.value.lastShownAt))) since = preferences.value.lastShownAt;
        else { const previous = new Date(now()); previous.setDate(previous.getDate()-1); previous.setHours(17,0,0,0); since = previous.toISOString(); }
      }
      let caughtUp = false;
      try {
        for (let page=0; page<4; page++) {
          const changes = await readWithDeadline(() => client.getChanges(cursor,{signal,since}),{signal});
          if (!Array.isArray(changes?.events)) throw new Error('Invalid changes');
          if (disposed || signal?.aborted) return;
          const ids = new Set(events.map(event => event.id));
          events = [...events,...changes.events.filter(event => !ids.has(event.id))].filter(event => Date.parse(event.recorded_at) >= Date.parse(since));
          cursor = changes.cursor ?? cursor;
          // An empty page establishes completion for this refresh only. A
          // previous poll's completion says nothing about new oldest-first pages.
          if (changes.events.length === 0) { caughtUp = true; break; }
        }
      } catch (error) {
        if ([401,403].includes(error.status)) throw error;
        // Ordinary read failures retain supported priorities, with coverage missing.
      }
      if (disposed || signal?.aborted) return;
      const next = morningBriefView(payload,{ now:now(),since,events,caughtUp });
      if (view?.spoken !== next.spoken) stop();
      view = next; render();
      if (dialog.open && preferences.value.day !== localDay(now())) remember();
      if (selected) {
        // Removed or reassigned records leave the popup immediately.
        const source = payload.sections[selected.kind === 'deal' ? 'deals' : selected.kind === 'action' ? 'today' : 'loops'];
        const admitted = source.state !== 'unavailable' && source.items.find(row => selected.kind === 'loop' ? String(row.number) === selected.id && row.kind === selected.loopKind : row.id === selected.id && (selected.kind !== 'action' || row.item_kind === 'next_action'));
        if (admitted) await showRecord(selected.kind === 'action' ? {...selected,action:admitted} : selected,{background:true}); else back();
      }
      if (automatic && preferences.value.day !== localDay(now()) && !root.querySelector('dialog[open]')) open();
    } catch { if (!disposed) clear(); }
  };
  const auto = mountAutoRefresh({ document:root,window:win,refresh,onResume:stop,intervalMs });
  control.onclick = () => { open(); auto.refresh(); };
  $('morningClose').onclick = close;
  dialog.addEventListener('close', () => { stop(); ++detailEpoch; selected = null; (opener?.isConnected && !opener.closest('dialog:not([open])') ? opener : $('docOpen'))?.focus(); });
  $('morningBack').onclick = back;
  $('morningRefresh').onclick = () => auto.refresh();
  $('morningContent').onclick = event => { const link = event.target.closest('[data-brief-record]'); if (!link) return; event.preventDefault(); const row = view?.groups[Number(link.dataset.briefRecord)]?.row; if (row) showRecord(row); };
  $('morningSpeech').onclick = () => { preferences?.save({speech:preferences.value.speech !== true}); stop(); controls(); };
  $('morningListen').onclick = () => {
    if (speaking) { stop(); return; }
    if ($('morningListen').disabled) return;
    const utterance = new win.SpeechSynthesisUtterance(view.spoken);
    const epoch = ++speechEpoch;
    utterance.rate = 1; utterance.onend = utterance.onerror = () => { if (epoch === speechEpoch) stop(); };
    speaking = true; $('morningListen').textContent = '■'; $('morningListen').setAttribute('aria-label','Stop morning brief');
    win.speechSynthesis.speak(utterance);
  };
  const hidden = () => { if (root.visibilityState === 'hidden') stop(); };
  root.addEventListener('visibilitychange',hidden);
  auto.refresh();
  return { open, refresh:auto.refresh, dispose() { if (disposed) return; disposed = true; usage.dispose(); stop(); ++detailEpoch; auto.dispose(); root.removeEventListener('visibilitychange',hidden); dialog.remove(); } };
}
