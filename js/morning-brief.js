import { briefWindow, composeMorningBrief, validBriefEvents } from './morning-brief-model.js';
import { localToday } from './calendar-model.js';
import { mountAutoRefresh, readWithDeadline, updatedLabel } from './auto-refresh.mjs';
import { escapeText as escape } from './change-receipts.mjs';

const SPEECH_KEY = 'doctorcre:brief-speech';
const FEED_PAGES = 20;
const speaker = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="doc-brief-wave" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>';
const item = row => `<a class="doc-brief-item" href="${escape(row.href)}" data-brief-key="${escape(row.key)}" data-tone="${escape(row.tone || 'change')}"><strong>${escape(row.name)}</strong><span>${escape(row.text)}</span><small>${escape(row.when)}</small></a>`;
const section = (id, title, rows, state = 'unavailable') => rows === null
  ? `<section id="${id}"><h3>${title}</h3><p class="doc-quiet">${state === 'incomplete' ? 'Incomplete' : 'Unavailable'}</p></section>`
  : rows.length ? `<section id="${id}"><h3>${title}</h3>${rows.map(item).join('')}</section>` : '';

// The mounted module owns presentation, read lifetime and speech intent.
// App-only memory advances only when a current brief is visibly presented.
export function mountMorningBrief({ document: root, window: win, strip, getClient, intervalMs = 30_000, timeoutMs = 10_000, now = () => new Date() }) {
  const storage = { get: key => { try { return win.localStorage.getItem(key); } catch { return null; } }, set: (key, value) => { try { win.localStorage.setItem(key, value); } catch {} } };
  const synth = win.speechSynthesis && win.SpeechSynthesisUtterance ? win.speechSynthesis : null;
  const opener = root.createElement('button');
  opener.id = 'docBriefOpen'; opener.type = 'button'; opener.className = 'doc-brief-open';
  opener.setAttribute('aria-label', 'Morning brief'); opener.title = 'Morning brief';
  opener.setAttribute('aria-controls', 'docBrief'); opener.setAttribute('aria-expanded', 'false');
  opener.innerHTML = '<span aria-hidden="true">☀</span>';
  strip.querySelector('.doc-updated').before(opener);
  const status = root.createElement('span');
  status.className = 'doc-brief-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  strip.append(status);
  const panel = root.createElement('section');
  panel.id = 'docBrief'; panel.className = 'doc-brief'; panel.hidden = true; panel.dataset.state = 'updating';
  panel.setAttribute('aria-labelledby', 'docBriefTitle');
  panel.innerHTML = `<header><span class="doc-orb" aria-hidden="true">◍</span><h2 id="docBriefTitle" tabindex="-1">Doc</h2><div class="doc-brief-tools"><button id="docBriefSpeech" type="button" aria-pressed="false" aria-label="Speak brief" title="Speak brief"${synth ? '' : ' hidden'}>${speaker}</button><time id="docBriefUpdated">Updating…</time><button id="docBriefRefresh" type="button" aria-label="Refresh brief" title="Refresh brief">↻</button><button id="docBriefClose" type="button" aria-label="Dismiss brief" title="Dismiss brief">×</button></div></header><div id="docBriefBody"><p class="doc-quiet">Updating…</p></div>`;
  strip.after(panel);
  const $ = selector => panel.querySelector(selector);
  let brief = null, engaged = false, actor = null, dismissedDay = null, windowDay = null, dayWindow = null, decided = false, pendingSpeech = false, cursor = null, events = new Map(), disposed = false;
  const speechOn = () => storage.get(SPEECH_KEY) === 'on';
  const place = () => { if (strip.parentElement && (panel.parentElement !== strip.parentElement || strip.nextElementSibling !== panel)) strip.after(panel); };
  const placement = new win.MutationObserver(place);
  placement.observe(root.body, { subtree:true, childList:true });
  const render = () => {
    place();
    $('#docBriefSpeech').setAttribute('aria-pressed', String(speechOn()));
    opener.setAttribute('aria-expanded', String(!panel.hidden));
    const body = $('#docBriefBody');
    const html = !brief ? `<p class="doc-quiet">${panel.dataset.state === 'updating' ? 'Updating…' : 'Unavailable'}</p>`
      : (brief.first ? `<section id="docBriefFirst" class="doc-brief-first"><h3>First</h3>${item(brief.first)}</section>` : '')
        + `<div class="doc-brief-grid">${section('docBriefOvernight', 'Overnight', brief.overnight)}${section('docBriefToday', 'Today', brief.today, brief.todayState)}</div>`;
    if (brief) $('#docBriefTitle').textContent = brief.greeting;
    else $('#docBriefTitle').textContent = 'Doc';
    if (body.innerHTML === html) return false;
    const focus = body.contains(root.activeElement) ? { key:root.activeElement.dataset.briefKey, section:root.activeElement.closest('section')?.id } : null;
    body.innerHTML = html;
    if (focus) ([...body.querySelectorAll('[data-brief-key]')].find(node => node.dataset.briefKey === focus.key && node.closest('section')?.id === focus.section) || $('#docBriefTitle')).focus({ preventScroll:true });
    return true;
  };
  const resetWindow = date => {
    if (!actor || windowDay === localToday(date)) return;
    let stored = null; try { stored = JSON.parse(storage.get(`doctorcre:brief:${actor}`)); } catch {}
    dayWindow = briefWindow(stored, date); windowDay = localToday(date);
    decided = !dayWindow.due || dismissedDay === windowDay; cursor = null; events = new Map(); brief = null;
    delete opener.dataset.ready;
    panel.dataset.state = 'updating'; $('#docBriefUpdated').textContent = 'Updating…';
    render();
  };
  const presented = () => {
    if (root.visibilityState === 'hidden' || panel.hidden || !brief || !dayWindow?.due) return;
    storage.set(`doctorcre:brief:${actor}`, JSON.stringify({ ...dayWindow.record, shownAt:now().toISOString() }));
    dayWindow.due = false;
  };
  // Each poll drains its own backlog to an empty terminal page. A historical
  // caught-up flag cannot establish that a later burst has been exhausted.
  const readChanges = async (client, signal) => {
    for (let page = 0; page < FEED_PAGES; page++) {
      const changes = await client.getChanges(cursor, { signal });
      if (signal.aborted || disposed) throw new Error('Read cancelled');
      if (!validBriefEvents(changes?.events)) throw new Error('Invalid change response');
      for (const event of changes.events) if (Date.parse(event.recorded_at) > Date.parse(dayWindow.since)) events.set(event.id, event);
      const next = changes.cursor ?? cursor;
      if (!changes.events.length) { cursor = next; return [...events.values()]; }
      if (next === cursor || next == null) throw new Error('Change feed did not advance');
      cursor = next;
    }
    return null;
  };
  const unavailable = () => {
    brief = null; events = new Map(); cursor = null; pendingSpeech = false; synth?.cancel();
    panel.dataset.state = 'unavailable'; $('#docBriefUpdated').textContent = 'Unavailable'; $('#docBriefUpdated').removeAttribute('datetime');
    status.textContent = 'Morning brief unavailable'; delete opener.dataset.ready; render();
  };
  const load = async signal => {
    resetWindow(now());
    const client = await getClient();
    if (signal.aborted || disposed) return;
    const [board, triage] = await Promise.allSettled([
      client.getBoard({ workspace:'all', signal }), client.todayTriage({ signal }),
    ]);
    if (signal.aborted || disposed) return;
    if (board.status !== 'fulfilled' || !composeMorningBrief({board:board.value,triage:null,events:null,since:null,now:now()})) throw new Error('Board unavailable');
    if (triage.status === 'rejected' && [401,403].includes(triage.reason?.status)) throw triage.reason;
    if (board.value.actor !== actor) {
      actor = board.value.actor; windowDay = null; decided = false; resetWindow(now());
    }
    let changes = null;
    try { changes = await readChanges(client, signal); }
    catch (error) { if ([401,403].includes(error?.status)) throw error; }
    if (signal.aborted || disposed) return;
    const date = now();
    // A midnight crossed during the read needs a new window, not yesterday's
    // rows stamped with today's presentation marker.
    if (localToday(date) !== windowDay) { resetWindow(date); throw new Error('Day changed during read'); }
    brief = composeMorningBrief({ board:board.value, triage:triage.status === 'fulfilled' ? triage.value : null, events:changes, since:dayWindow.since, now:date });
    const priorState = panel.dataset.state;
    panel.dataset.state = 'ready';
    const observed = date.toISOString(); $('#docBriefUpdated').textContent = updatedLabel(observed); $('#docBriefUpdated').dateTime = observed;
    let waiting = false;
    if (dayWindow.due && !decided) {
      decided = true;
      if (!engaged || !panel.hidden) { panel.hidden = false; pendingSpeech = true; }
      else { opener.dataset.ready = 'true'; waiting = true; }
    }
    const changed = render(); presented();
    if (waiting) status.textContent = 'Morning brief ready';
    else if (changed || priorState !== 'ready') status.textContent = brief.today === null || brief.overnight === null ? 'Morning brief updated; some sections unavailable or incomplete' : 'Morning brief updated';
    if (pendingSpeech && !panel.hidden && root.visibilityState !== 'hidden') {
      pendingSpeech = false;
      if (synth && speechOn()) { synth.cancel(); synth.speak(new win.SpeechSynthesisUtterance(brief.speech)); }
    }
  };
  const refresh = async ({ signal } = {}) => {
    try { await readWithDeadline(load, { signal, timeoutMs, clock:win }); }
    catch { if (!disposed) unavailable(); }
  };
  const engage = () => { engaged = true; };
  for (const type of ['pointerdown', 'keydown']) root.addEventListener(type, engage, { capture:true, once:true });
  const auto = mountAutoRefresh({ document:root, window:win, refresh, intervalMs, timeoutMs:timeoutMs + 1_000,
    shouldRefresh: () => windowDay !== localToday(now()) || !decided || !panel.hidden });
  const open = () => {
    decided = true; dismissedDay = null; delete opener.dataset.ready; panel.hidden = false; pendingSpeech = true;
    render(); $('#docBriefTitle').focus({ preventScroll:true }); panel.scrollIntoView?.({ block:'nearest' }); auto.refresh();
  };
  const close = () => { dismissedDay = localToday(now()); decided = true; panel.hidden = true; pendingSpeech = false; synth?.cancel(); render(); opener.focus(); };
  opener.onclick = () => panel.hidden ? open() : close();
  $('#docBriefClose').onclick = close;
  $('#docBriefRefresh').onclick = () => auto.refresh();
  $('#docBriefSpeech').onclick = () => {
    const on = !speechOn(); storage.set(SPEECH_KEY, on ? 'on' : 'off');
    pendingSpeech = on && !panel.hidden;
    if (pendingSpeech) auto.refresh(); else synth?.cancel();
    render();
  };
  auto.refresh();
  return { dispose: () => { disposed = true; pendingSpeech = false; auto.dispose(); placement.disconnect(); synth?.cancel(); for (const type of ['pointerdown', 'keydown']) root.removeEventListener(type, engage, { capture:true }); } };
}
