// The command dock: the one place a person sees what their last few commands
// did, and the only surface that offers the reconcile for an unanswered one.
//
// Everything decided lives in command-feedback.mjs. This is the adapter: it
// keeps the per-operation summaries a page maintains, renders the kernel's HTML
// into a root element, and turns a click into one of three callbacks. It
// re-renders only when the rendered signature changes, so a dock that is
// already correct is left alone and a focused button keeps its focus.
//
import { commandDockHtml, commandReceiptView } from './command-feedback.mjs';
import { showToast } from './toast.js';

/**
 * How many entries the dock keeps before it starts forgetting.
 *
 * Orchestrator ruling 2026-09-17: only CONFIRMED receipts are evicted, oldest
 * first. Pending, refused and unknown entries are never evicted — they are the
 * outstanding work a person still has to resolve — so the Map may exceed this
 * cap while unresolved work is outstanding.
 */
export const DOCK_ENTRY_CAP = 50;

// `actionable(operationKey)` hides an entry's action while the page cannot send
// it (a switched-off feature); the receipt itself stays visible. Call render()
// when the answer changes. Hiding is presentation: the page's dispatch still
// enforces its own gate.
export function createCommandDock({ root, onDispatch = null, onReconcile = null, onUndo = null, actionable = () => true } = {}) {
  // Insertion order IS display order: a Map preserves it, and re-recording an
  // operation updates it in place rather than moving it to the front.
  const entries = new Map();
  let signature = null;
  let wired = false;

  const views = () => [...entries.values()]
    .filter((entry) => !entry.dismissed && commandReceiptView(entry).state !== 'confirmed')
    .map(commandReceiptView);

  function present() {
    if (!root) return;
    for (const receipt of root.querySelectorAll('.receipt[data-op]')) {
      const entry = entries.get(receipt.dataset.op);
      if (!entry) continue;
      const state = commandReceiptView(entry).state;
      if (!['refused', 'unknown'].includes(state) || receipt.querySelector('[data-dock-close]')) continue;
      const close = root.ownerDocument.createElement('button');
      close.type = 'button';
      close.className = 'btn btn-quiet receipt-dismiss';
      close.dataset.dockClose = '';
      close.dataset.op = entry.operationKey;
      close.setAttribute('aria-label', `Dismiss ${entry.summary || 'command notification'}`);
      close.textContent = 'Close';
      receipt.lastElementChild?.append(close);
    }
  }

  function render() {
    if (!root) return '';
    const html = commandDockHtml(views());
    if (html !== signature) {
      signature = html;
      root.innerHTML = html;
    }
    present();
    for (const button of root.querySelectorAll('button[data-op][data-event]')) button.hidden = !actionable(button.dataset.op);
    return html;
  }

  /**
   * What the dock shows for one operation. `status` is a kernel status and
   * `state` a feedback state; a caller may pass either, and the kernel decides.
   */
  function record(operationKey, { summary = '', status = null, state = null, reason = null, retry = false, undo = false, request = null, clearRequest = false } = {}) {
    const previous = entries.get(operationKey) || {};
    const previousState = previous.operationKey ? commandReceiptView(previous).state : null;
    const next = {
      ...previous, operationKey,
      summary: summary || previous.summary || '',
      status, state, reason, retry, undo,
      // A settled command holding a secret asks to be forgotten; otherwise the last request is kept for replay.
      request: clearRequest ? null : request || previous.request || null,
      dismissed: false,
    };
    const nextState = commandReceiptView(next).state;
    entries.set(operationKey, next);
    if (nextState === 'confirmed' && previousState !== 'confirmed' && root) {
      showToast(next.summary || 'Change confirmed', { preserveUndo: true });
    }
    evict();
    render();
    return entries.get(operationKey);
  }

  /**
   * Insertion order IS age order, so the first confirmed entry the walk finds
   * is the oldest one that may go. When nothing confirmed is left, the dock
   * stays over the cap rather than dropping work still owed an answer.
   */
  function evict() {
    while (entries.size > DOCK_ENTRY_CAP) {
      let oldestConfirmed = null;
      for (const [key, entry] of entries) {
        if (commandReceiptView(entry).state === 'confirmed') { oldestConfirmed = key; break; }
      }
      if (oldestConfirmed === null) return;
      entries.delete(oldestConfirmed);
    }
  }

  function forget(operationKey) {
    entries.delete(operationKey);
    render();
  }

  function mount() {
    if (!root || wired) return;
    wired = true;
    root.addEventListener('click', (event) => {
      const close = event.target.closest('button[data-dock-close][data-op]');
      if (close && root.contains(close)) {
        const operationKey = close.dataset.op;
        const entry = entries.get(operationKey);
        if (entry && ['refused', 'unknown'].includes(commandReceiptView(entry).state)) {
          entry.dismissed = true;
          render();
        }
        return;
      }
      const button = event.target.closest('button[data-op][data-event]');
      if (!button || !root.contains(button)) return;
      const operationKey = button.dataset.op;
      const entry = entries.get(operationKey) || { operationKey };
      const handler = { dispatch: onDispatch, reconcile: onReconcile, undo: onUndo }[button.dataset.event];
      if (typeof handler === 'function') handler(operationKey, entry);
    });
    render();
  }

  return { record, forget, render, mount, entries };
}
