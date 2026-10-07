import { groupConversations, labelFor, modelFor, summarizeNow } from './observatory-model.js';

const $ = (id) => document.getElementById(id);
const state = { activity: [], conversation: [], before: null, more: false, selected: new URLSearchParams(location.search).get('thread'), loading: false, searched: false };
const DEEP_LINK_PAGE_LIMIT = 5;
const seen = (rows) => new Map(rows.map((row) => [String(row.msg_id || row.seq), row]));
const merge = (oldRows, incoming) => [...seen([...oldRows, ...incoming]).values()].sort((a, b) => Number(a.seq) - Number(b.seq));
const formatTime = (at) => at ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unknown time';
const age = (at) => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(at || '')) / 1000));
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};
const node = (tag, className, content) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (content !== undefined) item.textContent = content;
  return item;
};
const clear = (target) => { target.replaceChildren(); return target; };
const summary = (value, fallback) => String(value || fallback).trim().slice(0, 150);

async function readLatest(mode = 'all', before = null) {
  const params = new URLSearchParams({ mode, limit: '200' });
  if (before) params.set('before_seq', String(before));
  const response = await fetch(`/api/room/latest?${params}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (response.status === 401) { location.href = `/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}`; throw new Error('sign_in_required'); }
  if (!response.ok) throw new Error(`Room read failed (${response.status})`);
  return response.json();
}

function renderDetail(target, rows, kind, emptyText, display) {
  clear(target);
  if (!rows.length) { target.append(node('p', 'empty', emptyText)); return; }
  for (const row of rows) {
    const item = node('div', `detail-row ${kind}`);
    item.append(node('strong', '', display(row)));
    item.append(node('span', '', row.beat_at || row.last_live_at || row.at ? age(row.beat_at || row.last_live_at || row.at) : 'Time not recorded'));
    target.append(item);
  }
}

function turnElement(turn) {
  const speaker = labelFor(turn);
  const item = node('div', 'turn');
  item.dataset.speaker = turn.seat === 'human' ? 'human' : 'model';
  item.append(node('span', 'avatar', speaker.slice(0, 1)));
  const content = node('div');
  const head = node('div', 'turn-head');
  head.append(node('strong', '', speaker));
  head.append(node('span', '', modelFor(turn)));
  head.append(node('span', '', formatTime(turn.at)));
  content.append(head, node('p', 'turn-body', turn.body));
  item.append(content);
  return item;
}

function renderThread(thread) {
  const host = clear($('currentThread'));
  $('conversationTitle').textContent = state.selected ? 'Selected thread' : 'Latest thread';
  if (!thread) {
    host.append(node('p', 'empty', state.selected
      ? state.more ? 'Selected thread is outside the loaded history. Load older threads to continue.' : 'Selected thread was not found in the recorded history.'
      : 'No conversation turns have been recorded in this window.'));
    return;
  }
  const header = node('div', 'thread-header');
  const heading = node('div');
  heading.append(node('p', 'eyebrow', 'Model Room thread'), node('h3', '', thread.title));
  heading.append(node('span', 'meta', `${thread.participants.join(' · ')} · ${thread.turnCount} turn${thread.turnCount === 1 ? '' : 's'} · ${formatTime(thread.firstAt)}–${formatTime(thread.lastAt)}`));
  header.append(heading);
  host.append(header);
  const stack = node('div', 'turn-stack');
  for (const turn of thread.turns) stack.append(turnElement(turn));
  host.append(stack);
}

function renderArchive(threads, selected) {
  const host = clear($('archiveList'));
  const rest = threads.filter((thread) => thread.key !== selected?.key);
  $('archiveCount').textContent = `${rest.length} shown`;
  if (!rest.length) host.append(node('p', 'empty', 'No older threads in the loaded history.'));
  for (const thread of rest) {
    const link = node('a', 'archive-item');
    link.href = `/control-room/observatory?thread=${encodeURIComponent(thread.key)}`;
    link.append(node('strong', '', thread.title));
    link.append(node('span', '', `${thread.participants.join(' · ')} · ${thread.turnCount} turn${thread.turnCount === 1 ? '' : 's'}`));
    link.append(node('span', 'archive-date', `${formatTime(thread.firstAt)} – ${formatTime(thread.lastAt)}`));
    host.append(link);
  }
  $('loadOlder').hidden = !state.more;
}

function renderNow() {
  const now = summarizeNow(merge(state.activity, state.conversation), Date.now());
  const bridgeAt = now.heartbeat?.cycle_at || now.heartbeat?.at;
  const bridgeAge = bridgeAt ? Date.now() - Date.parse(bridgeAt) : Infinity;
  const liveAge = now.latestAt ? Date.now() - Date.parse(now.latestAt) : Infinity;
  const condition = !Number.isFinite(liveAge) || liveAge > 15 * 60_000 ? 'urgent'
    : bridgeAge > 15 * 60_000 ? 'attention' : 'healthy';
  $('liveOrb').dataset.state = condition;
  $('presenceDot').dataset.state = condition;
  $('freshness').textContent = `Latest room turn ${age(now.latestAt)} · bridge ${bridgeAt ? age(bridgeAt) : 'unreported'}`;
  $('presenceText').textContent = condition === 'healthy' ? 'Room current' : condition === 'attention' ? 'Bridge check-in late' : 'Room freshness needs attention';
  $('figCycle').textContent = bridgeAt ? age(bridgeAt) : '—';
  $('figBridge').textContent = now.heartbeat?.cursor ?? '—';
  $('figDesks').textContent = now.heartbeat?.desks?.filter((desk) => desk.live).length ?? '—';
  const attention = [...now.attention];
  if (bridgeAge > 15 * 60_000) attention.unshift({ summary: 'Bridge check-in is late', at: bridgeAt });
  for (const [id, count] of [['running', now.running.length], ['attention', attention.length], ['finished', now.finished.length]]) {
    $(`${id}Count`).textContent = String(count);
    $(`flow${id[0].toUpperCase()}${id.slice(1)}`).textContent = String(count);
  }
  $('runningSummary').textContent = now.running[0]?.title || now.running[0]?.name || 'No session checked in recently';
  $('attentionSummary').textContent = now.attention[0] ? 'One or more refusals or failures' : bridgeAge > 15 * 60_000 ? 'Bridge check-in late' : 'No current failure receipt';
  $('finishedSummary').textContent = now.finished[0]?.summary || 'No recent completion receipt';
  $('runningFreshness').textContent = `${now.running.length} active check-in${now.running.length === 1 ? '' : 's'}`;
  renderDetail($('runningList'), now.running, 'running', 'No session has checked in during the last 10 minutes.',
    (row) => `${row.name || row.handle || row.runtime || 'Session'} · ${summary(row.title, row.model || 'Working')} ${row.model ? `· ${row.model}` : ''}`);
  renderDetail($('attentionList'), attention, 'attention', 'No failure receipt in the last 24 hours.',
    (row) => summary(row.summary || row.detail || row.reason, 'A delivery or control request failed'));
  renderDetail($('finishedList'), now.finished, 'finished', 'No completion receipt in the last 24 hours.',
    (row) => summary(row.summary || row.result || row.outcome, 'Work completed'));
  const recentThreads = groupConversations(state.conversation)
    .filter((thread) => Date.now() - Date.parse(thread.lastAt) <= 24 * 60 * 60_000).slice(0, 3);
  const nowDialogue = clear($('nowDialogue'));
  if (recentThreads[0]) {
    const thread = recentThreads[0];
    const heading = node('div', 'now-dialogue-heading');
    const title = node('div');
    title.append(node('p', 'eyebrow', `Latest conversation · ${age(thread.lastAt)}`));
    const link = node('a', 'now-dialogue-link', thread.title);
    link.href = `/control-room/observatory?thread=${encodeURIComponent(thread.key)}`;
    title.append(link, node('span', 'meta', thread.participants.join(' · ')));
    heading.append(title);
    nowDialogue.append(heading);
    for (const turn of thread.turns.slice(-2)) {
      const line = node('div', 'now-dialogue-turn');
      line.append(node('strong', '', labelFor(turn)), node('span', 'now-model', modelFor(turn)),
        node('span', 'now-quote', summary(turn.body, 'Turn recorded')));
      nowDialogue.append(line);
    }
  } else {
    nowDialogue.append(node('p', 'eyebrow', 'Conversation watch'),
      node('p', 'empty', 'No spoken turn in the last 24 hours. Session check-ins may still be current.'));
  }
}

function render() {
  renderNow();
  const threads = groupConversations(state.conversation);
  const selected = state.selected ? threads.find((thread) => thread.key === state.selected) : threads[0];
  renderThread(selected);
  renderArchive(threads, selected);
}

function toast(text) {
  $('roomToast').textContent = text;
  $('roomToast').hidden = false;
  setTimeout(() => { $('roomToast').hidden = true; }, 6000);
}

async function loadOlder() {
  if (!state.more || state.loading || !state.before) return;
  state.loading = true;
  $('loadOlder').disabled = true;
  try {
    const page = await readLatest('conversation', state.before);
    state.conversation = merge(state.conversation, page.turns || []);
    state.before = page.before_seq;
    state.more = Boolean(page.more && page.turns?.length);
    render();
  } catch (error) { toast(error.message); }
  finally { state.loading = false; $('loadOlder').disabled = false; }
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $('refreshButton').disabled = true;
  $('loadOlder').disabled = true;
  try {
    const [activity, conversation] = await Promise.all([readLatest('all'), readLatest('conversation')]);
    state.activity = merge(state.activity, activity.turns || []).slice(-600);
    state.conversation = merge(state.conversation, conversation.turns || []);
    if (state.before === null) { state.before = conversation.before_seq; state.more = Boolean(conversation.more); }
    if (state.selected && !state.searched) {
      let pages = 0;
      while (state.more && state.before && pages < DEEP_LINK_PAGE_LIMIT
        && !groupConversations(state.conversation).some(thread => thread.key === state.selected)) {
        const page = await readLatest('conversation', state.before);
        state.conversation = merge(state.conversation, page.turns || []);
        state.before = page.before_seq;
        state.more = Boolean(page.more && page.turns?.length);
        pages++;
      }
      state.searched = true;
    }
    render();
  } catch (error) {
    if (error.message !== 'sign_in_required') {
      $('liveOrb').dataset.state = 'urgent';
      $('freshness').textContent = `Room read unavailable · ${error.message}`;
      toast(error.message);
    }
  } finally {
    state.loading = false;
    $('refreshButton').disabled = false;
    $('loadOlder').disabled = false;
  }
}

document.querySelectorAll('[data-focus]').forEach((item) => item.addEventListener('click', () => {
  const id = `${item.dataset.focus}Panel`;
  $(id)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
}));
$('refreshButton').addEventListener('click', refresh);
$('loadOlder').addEventListener('click', loadOlder);
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 10_000);
