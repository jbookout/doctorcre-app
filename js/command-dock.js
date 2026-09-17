// The command dock: the one place a person sees what their last few commands
// did, and the only surface that offers the reconcile for an unanswered one.
//
// Everything decided lives in command-feedback.mjs. This is the adapter: it
// keeps the per-operation summaries a page maintains, renders the kernel's HTML
// into a root element, and turns a click into one of three callbacks. It
// re-renders only when the rendered signature changes, so a dock that is
// already correct is left alone and a focused button keeps its focus.
//
// `onUndo` is wired by no production page today. The dock keys on operations;
// Undo keys on change-feed events and lives in the Recent changes popup
// (change-receipts.mjs). The hook stays for a page whose operation maps to
// exactly one event; see the header of command-feedback.mjs for why the two
// key spaces are kept apart on purpose.
import { commandDockHtml, commandReceiptView } from './command-feedback.mjs';

/**
 * How many entries the dock keeps before it starts forgetting.
 *
 * Orchestrator ruling 2026-09-17: only CONFIRMED receipts are evicted, oldest
 * first. Pending, refused and unknown entries are never evicted — they are the
 * outstanding work a person still has to resolve — so the Map may exceed this
 * cap while unresolved work is outstanding.
 */
export const DOCK_ENTRY_CAP = 50;

export function createCommandDock({ root, onDispatch = null, onReconcile = null, onUndo = null } = {}) {
  // Insertion order IS display order: a Map preserves it, and re-recording an
  // operation updates it in place rather than moving it to the front.
  const entries = new Map();
  let signature = null;
  let wired = false;

  const views = () => [...entries.values()].map(commandReceiptView);

  function render() {
    if (!root) return '';
    const html = commandDockHtml(views());
    if (html === signature) return html;
    signature = html;
    root.innerHTML = html;
    return html;
  }

  /**
   * What the dock shows for one operation. `status` is a kernel status and
   * `state` a feedback state; a caller may pass either, and the kernel decides.
   */
  function record(operationKey, { summary = '', status = null, state = null, reason = null, retry = false, undo = false, request = null } = {}) {
    const previous = entries.get(operationKey) || {};
    entries.set(operationKey, {
      ...previous, operationKey,
      summary: summary || previous.summary || '',
      status, state, reason, retry, undo,
      request: request || previous.request || null,
    });
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
