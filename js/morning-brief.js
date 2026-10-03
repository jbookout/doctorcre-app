import { briefWindow, composeMorningBrief } from './morning-brief-model.js';
import { mountAutoRefresh, readWithDeadline, updatedLabel } from './auto-refresh.mjs';
import { createFeedProgress, observeChangeBatch, escapeText as escape } from './change-receipts.mjs';

const SPEECH_KEY = 'doctorcre:brief-speech';
const FEED_PAGES = 20;
const speaker = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="doc-brief-wave" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>';
const item = row => `<a class="doc-brief-item" href="${escape(row.href)}" data-tone="${escape(row.tone || 'change')}"><strong>${escape(row.name)}</strong><span>${escape(row.text)}</span><small>${escape(row.when)}</small></a>`;
const section = (id, title, rows) => rows === null
  ? `<section id="${id}"><h3>${title}</h3><p class="doc-quiet">Unavailable</p></section>`
  : rows.length ? `<section id="${id}"><h3>${title}</h3>${rows.map(item).join('')}</section>` : '';

// The brief sits under Doc's strip in the main region, never over the page:
// it opens itself once a day without taking the page away from the partner.
export function mountMorningBrief({ document: root, window: win, strip, getClient, intervalMs = 30_000 }) {
  const storage = { get: key => { try { return win.localStorage.getItem(key); } catch { return null; } }, set: (key, value) => { try { win.localStorage.setItem(key, value); } catch {} } };
  const synth = win.speechSynthesis && win.SpeechSynthesisUtterance ? win.speechSynthesis : null;
  const opener = root.createElement('button');
  opener.id = 'docBriefOpen'; opener.type = 'button'; opener.className = 'doc-brief-open';
  opener.setAttribute('aria-label', 'Morning brief'); opener.title = 'Morning brief';
  opener.setAttribute('aria-controls', 'docBrief'); opener.setAttribute('aria-expanded', 'false');
  opener.innerHTML = '<span aria-hidden="true">☀</span>';
  strip.querySelector('.doc-updated').before(opener);
  const panel = root.createElement('section');
  panel.id = 'docBrief'; panel.className = 'doc-brief'; panel.hidden = true; panel.dataset.state = 'updating';
  panel.setAttribute('aria-labelledby', 'docBriefTitle');
  panel.innerHTML = `<header><span class="doc-orb" aria-hidden="true">◍</span><h2 id="docBriefTitle" tabindex="-1">Doc</h2><div class="doc-brief-tools"><button id="docBriefSpeech" type="button" aria-pressed="false" aria-label="Speak brief" title="Speak brief"${synth ? '' : ' hidden'}>${speaker}</button><time id="docBriefUpdated">Updating…</time><button id="docBriefRefresh" type="button" aria-label="Refresh brief" title="Refresh brief">↻</button><button id="docBriefClose" type="button" aria-label="Dismiss brief" title="Dismiss brief">×</button></div></header><div id="docBriefBody"></div>`;
  strip.after(panel);
  const $ = selector => panel.querySelector(selector);
  let brief = null, arriving = false, engaged = false, actor = null, since = null, decided = false, speakWhenReady = false, cursor = null, feed = createFeedProgress(), events = new Map();

  const speechOn = () => storage.get(SPEECH_KEY) === 'on';
  const say = () => {
    if (!synth || !speechOn()) return;
    if (!brief) { speakWhenReady = true; return; }
    speakWhenReady = false; synth.cancel(); synth.speak(new win.SpeechSynthesisUtterance(brief.speech));
  };
  const render = () => {
    $('#docBriefSpeech').setAttribute('aria-pressed', String(speechOn()));
    opener.setAttribute('aria-expanded', String(!panel.hidden));
    if (!brief) return;
    $('#docBriefTitle').textContent = brief.greeting;
    const html = (brief.first ? `<section id="docBriefFirst" class="doc-brief-first"><h3>First</h3>${item(brief.first)}</section>` : '')
      + `<div class="doc-brief-grid">${section('docBriefOvernight', 'Overnight', brief.overnight)}${section('docBriefToday', 'Today', brief.today)}</div>`;
    if ($('#docBriefBody').innerHTML !== html) $('#docBriefBody').innerHTML = html;
  };
  // The change feed starts at the oldest event; advance it to the present and
  // keep only what falls inside the overnight window. Unknown until caught up.
  const readChanges = async (client, signal) => {
    for (let page = 0; page < FEED_PAGES; page++) {
      const changes = await readWithDeadline(() => client.getChanges(cursor), { signal });
      if (!Array.isArray(changes?.events)) throw new Error('Invalid change response');
      const current = feed.caught_up;
      feed = observeChangeBatch(feed, changes.events);
      for (const event of changes.events) if (Date.parse(event?.recorded_at) > Date.parse(since)) events.set(event.id, event);
      cursor = changes.cursor ?? cursor;
      if (current || feed.caught_up) break;
    }
    return feed.caught_up ? [...events.values()] : null;
  };
  const refresh = async ({ signal } = {}) => {
    const client = await getClient();
    const [board, triage] = await Promise.allSettled([
      readWithDeadline(() => client.getBoard({ workspace:'all' }), { signal }),
      readWithDeadline(() => client.todayTriage(), { signal }),
    ]);
    if (signal?.aborted) return;
    const now = new Date();
    const boardValue = board.status === 'fulfilled' ? board.value : null;
    if (boardValue?.actor && boardValue.actor !== actor) {
      actor = boardValue.actor; cursor = null; feed = createFeedProgress(); events = new Map();
      let stored = null; try { stored = JSON.parse(storage.get(`doctorcre:brief:${actor}`)); } catch {}
      const day = briefWindow(stored, now);
      since = day.since;
      if (day.due) { storage.set(`doctorcre:brief:${actor}`, JSON.stringify(day.record)); arriving = !decided; } else decided = true;
    }
    if (!since) { panel.dataset.state = 'unavailable'; render(); return; }
    let changes = null;
    try { changes = await readChanges(client, signal); } catch {}
    if (signal?.aborted) return;
    const next = composeMorningBrief({ board: boardValue, triage: triage.status === 'fulfilled' ? triage.value : null, events: changes, since, now });
    if (next) {
      brief = next; panel.dataset.state = 'ready';
      const observed = now.toISOString(); $('#docBriefUpdated').textContent = updatedLabel(observed); $('#docBriefUpdated').dateTime = observed;
    } else panel.dataset.state = brief ? 'ready' : 'unavailable';
    // Never move the page under a partner who is already using it: once they
    // have pressed anything, the brief waits behind Doc's lit brief button.
    const opening = arriving && Boolean(brief) && !engaged;
    if (arriving && brief) { arriving = false; decided = true; if (opening) panel.hidden = false; else opener.dataset.ready = 'true'; }
    render();
    if (opening || (speakWhenReady && brief)) say();
  };
  const engage = () => { engaged = true; };
  for (const type of ['pointerdown', 'keydown']) root.addEventListener(type, engage, { capture:true, once:true });
  const auto = mountAutoRefresh({ document:root, window:win, refresh, intervalMs, shouldRefresh: () => !decided || !panel.hidden });
  const open = () => { decided = true; arriving = false; delete opener.dataset.ready; panel.hidden = false; render(); $('#docBriefTitle').focus({ preventScroll:true }); panel.scrollIntoView?.({ block:'nearest' }); say(); auto.refresh(); };
  const close = () => { panel.hidden = true; synth?.cancel(); render(); opener.focus(); };
  opener.onclick = () => panel.hidden ? open() : close();
  $('#docBriefClose').onclick = close;
  $('#docBriefRefresh').onclick = () => auto.refresh();
  $('#docBriefSpeech').onclick = () => {
    const on = !speechOn(); storage.set(SPEECH_KEY, on ? 'on' : 'off');
    if (on) say(); else { speakWhenReady = false; synth?.cancel(); }
    render();
  };
  auto.refresh();
  return { dispose: () => { auto.dispose(); synth?.cancel(); for (const type of ['pointerdown', 'keydown']) root.removeEventListener(type, engage, { capture:true }); } };
}
