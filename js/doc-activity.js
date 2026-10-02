import { createFixtureClient } from './fixture-client.js';
import { createLiveClient } from './live-client.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { mountAutoRefresh, readWithDeadline, updatedLabel } from './auto-refresh.mjs';
import { activityFilters, activityRows, typeLabel, undoArgs, undoLabel } from './doc-activity-model.js';
import { uuidv4 } from './uuid.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const stamp = value => new Date(value).toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true });
const shown = value => value === null || value === undefined ? '—' : String(value).replace(/_/g,' ');

export function mountDocActivity({ document: root, window, client, intervalMs = 30_000 }) {
  const $ = id => root.getElementById(id), form = $('activityFilters'), dialog = $('activityDetail');
  const view = { rows: [], sequence: 0, pages: 1, next: null, selected: null, opener: null, attempts: new Map(), fingerprint: '' };
  const message = text => { $('activityStatus').textContent = text; };
  const attemptLabel = row => {
    const attempt = view.attempts.get(row.id);
    return attempt?.state === 'pending' ? 'Undoing…' : attempt?.state === 'unknown' ? 'Check undo'
      : attempt?.state === 'done' ? 'Undone' : undoLabel(row.undo?.state);
  };
  const canUndo = row => row.undo?.state === 'available' || view.attempts.get(row.id)?.state === 'unknown';
  function paintDetail() {
    const row = view.rows.find(row => row.id === view.selected);
    if (!row) return;
    $('detailWho').textContent = `${row.actor || 'Automation'} · ${row.partner ? typeLabel(row.partner) : 'Team'} · ${stamp(row.at)}`;
    $('detailTitle').textContent = row.record.name;
    $('detailWhat').textContent = row.what;
    $('detailWhy').textContent = row.why || 'Reason not recorded';
    $('detailEvidence').textContent = row.evidence?.kind === 'entry' ? `Recorded entry · ${stamp(row.evidence.at || row.at)}` : 'Evidence not recorded';
    $('detailChange').innerHTML = row.before !== null || row.after !== null
      ? `<span>${esc(shown(row.before))}</span><b aria-label="changed to">→</b><span>${esc(shown(row.after))}</span>` : '';
    $('detailOriginalAt').textContent = stamp(row.evidence?.at || row.at);
    $('detailOriginalText').textContent = row.evidence?.summary || row.evidence?.reason || row.what;
    $('detailQuote').hidden = !row.evidence?.quote;
    $('detailQuote').textContent = row.evidence?.quote || '';
    $('detailUndo').textContent = attemptLabel(row);
    $('detailUndo').disabled = !canUndo(row) || view.attempts.get(row.id)?.state === 'pending' || view.attempts.get(row.id)?.state === 'done';
  }
  function paint() {
    // Unchanged polling preserves keyboard focus, reading position and motion.
    const html = view.rows.map(row => `<li class="activity-row" data-event="${esc(row.id)}">
      <button class="activity-open" data-open="${esc(row.id)}" aria-label="${esc(`${row.what}: ${row.record.name}`)}">
        <span class="activity-icon" aria-hidden="true">${row.record.type === 'deal' ? '↗' : row.record.type === 'document' ? '▤' : '◈'}</span>
        <span class="activity-subject"><strong>${esc(row.what)}</strong><span>${esc(row.record.name)}</span>
          <span class="activity-meta">${esc(row.actor || 'Automation')} · ${esc(row.partner ? typeLabel(row.partner) : 'Team')} · ${esc(typeLabel(row.record.type))}</span></span>
        <span class="activity-note">${esc(row.why || 'Reason not recorded')}<span class="activity-evidence">${row.evidence ? 'Recorded entry ↗' : 'Evidence not recorded'}</span></span>
        <time class="activity-time" datetime="${esc(row.at)}">${esc(stamp(row.at))}</time>
      </button><div class="activity-row-action">${canUndo(row) ? `<button data-undo="${esc(row.id)}" ${['pending','done'].includes(view.attempts.get(row.id)?.state) ? 'disabled' : ''}>${esc(attemptLabel(row))}</button>` : esc(attemptLabel(row))}</div></li>`).join('');
    if (html !== view.fingerprint) {
      const focused = root.activeElement?.dataset, focusId = focused?.undo || focused?.open;
      const focusKind = focused?.undo ? 'undo' : 'open';
      $('activityFeed').innerHTML = html; view.fingerprint = html;
      if (focusId) [...$('activityFeed').querySelectorAll(`[data-${focusKind}]`)].find(el => el.dataset[focusKind] === focusId)?.focus();
    }
    $('activityMore').hidden = !view.next;
    if (dialog.open) {
      if (view.rows.some(row => row.id === view.selected)) paintDetail();
      else { dialog.close(); view.selected = null; }
    }
  }
  async function refresh({ signal } = {}) {
    const seq = ++view.sequence;
    try {
      const values = Object.fromEntries(new window.FormData(form)), args = activityFilters(values);
      if (args.since && args.until && Date.parse(args.since) >= Date.parse(args.until)) { message('Choose a valid date range'); return; }
      const entries = [], cursors = new Set(); let answer, cursor = null;
      for (let page = 0; page < view.pages; page++) {
        answer = await readWithDeadline(current => client.readDocActivity({ ...args, ...(cursor ? { cursor } : {}) }, { signal: current }), { signal });
        entries.push(...activityRows(answer)); cursor = answer.next_cursor;
        if (!cursor) break;
        const key = JSON.stringify(cursor); if (cursors.has(key)) throw new Error('activity_paging'); cursors.add(key);
      }
      if (seq !== view.sequence) return;
      view.rows = activityRows({ ...answer, entries }); view.next = cursor;
      const select = form.elements.record_type, selected = select.value;
      const types = [...new Set([...(answer.record_types || []), ...(selected ? [selected] : [])])].sort();
      const options = `<option value="">All records</option>${types.map(type => `<option value="${esc(type)}">${esc(typeLabel(type))}</option>`).join('')}`;
      if (select.innerHTML !== options) { select.innerHTML = options; select.value = selected; }
      $('activityUpdated').textContent = updatedLabel(answer.as_of);
      message(view.rows.length ? '' : 'No activity'); paint();
    } catch {
      if (seq === view.sequence) { message('Activity temporarily unavailable'); $('activityUpdated').textContent = 'Updating…'; }
    }
  }
  async function undo(id) {
    const row = view.rows.find(row => row.id === id);
    let attempt = view.attempts.get(id);
    if (attempt?.state === 'pending' || attempt?.state === 'done') return;
    if (!attempt) {
      const args = undoArgs(row, uuidv4()); if (!args) return;
      attempt = { args, state: 'pending' }; view.attempts.set(id, attempt);
    }
    attempt.state = 'pending'; paint(); $('detailResult').textContent = '';
    try {
      const result = await readWithDeadline(() => client.revertDealField(attempt.args), { timeoutMs: 10_000 });
      if (result?.ok !== true || result.reverted_event_id !== id) throw new Error('undo_unconfirmed');
      attempt.state = 'done'; message('Change undone'); $('detailResult').textContent = 'Change undone'; paint();
      await refresh();
    } catch (error) {
      if (['newer_change_exists','event_not_revertible'].includes(error.payload?.error) || [401,403].includes(error.status)) {
        view.attempts.delete(id); message('Undo unavailable'); $('detailResult').textContent = 'Undo unavailable';
        await refresh();
      } else {
        attempt.state = 'unknown'; message('Undo not confirmed'); $('detailResult').textContent = 'Undo not confirmed';
      }
      paint();
    }
  }
  const close = () => { dialog.close(); const opener = [...$("activityFeed").querySelectorAll("[data-open]")].find(el => el.dataset.open === view.selected) || view.opener; view.selected = null; if (opener?.isConnected) opener.focus(); };
  $('activityFeed').addEventListener('click', event => {
    const undoButton = event.target.closest('[data-undo]');
    if (undoButton) { void undo(undoButton.dataset.undo); return; }
    const button = event.target.closest('[data-open]'); if (!button) return;
    view.selected = button.dataset.open; view.opener = button; $('detailOriginal').open = false;
    $('detailResult').textContent = ''; paintDetail(); dialog.showModal(); $('detailClose').focus();
  });
  $('detailClose').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  $('detailUndo').addEventListener('click', () => { void undo(view.selected); });
  const resetPage = () => { view.pages = 1; void refresh(); };
  form.addEventListener('change', resetPage);
  form.addEventListener('submit', event => { event.preventDefault(); resetPage(); });
  form.addEventListener('reset', () => { window.setTimeout(resetPage, 0); });
  $('activityMore').addEventListener('click', () => { view.pages++; void refresh(); });
  const polling = mountAutoRefresh({ document: root, window, refresh, intervalMs });
  $('activityRefresh').addEventListener('click', () => { void polling.refresh(); });
  void refresh();
  return { refresh, dispose() { view.sequence++; polling.dispose(); }, view };
}
if (typeof document !== 'undefined' && document.getElementById('activityFeed')) {
  const boot = resolveDealroomBoot(location);
  const client = boot.mode === 'live' ? createLiveClient(boot.options) : await createFixtureClient(boot.options);
  mountDocActivity({ document, window, client });
}
