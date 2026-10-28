// Read-only background updates. One refresh runs at a time; hidden and idle
// pages sleep (see visibility-poll.mjs). Current-read lifetimes own
// cancellation; page callbacks preserve their local drafts.
import { createCurrentRead } from "./current-read.mjs";
export { readWithDeadline, fetchRead } from "./current-read.mjs";
import { pollSafety, POLL_LIMITS } from "./poll-safety.mjs";
import { watchPresence } from "./visibility-poll.mjs";

export function mountAutoRefresh({ document, window, refresh, onResume, onWake, intervalMs = 30_000, timeoutMs = 30_000, shouldRefresh = () => true, idleMs, now }) {
  if (!window?.addEventListener || !document?.addEventListener) return { refresh: () => {}, revalidate: () => {}, poll: () => {}, dispose: () => {} };
  const safety = pollSafety(window, { document, now });
  const source = {};
  let timer = null;
  let running = null;
  let queuedResume = null;
  let disposed = false;
  let initialized = false;
  const reads = createCurrentRead({ timeoutMs, clock: window });
  const clockNow = now || (() => Date.now());
  const schedule = (deferred = false) => {
    window.clearTimeout?.(timer);
    const state = safety.state();
    const delay = Math.max(deferred ? POLL_LIMITS.gapMs : intervalMs, state.nextAt - clockNow());
    if (!state.paused && !disposed && document.visibilityState !== "hidden" && window.setTimeout) { timer = window.setTimeout(read, delay); timer?.unref?.(); }
  };
  const run = (operation, manual = false, initial = false) => {
    // Idle stops the clock here; the first input re-reads through the resume.
    if (disposed || !presence.active()) return Promise.resolve();
    if (!shouldRefresh()) { schedule(); return Promise.resolve(); }
    if (running) { if (manual) safety.promote(source); return running; }
    window.clearTimeout?.(timer);
    // A read replaced by a resume settles neither way; the queued read decides.
    let accepted = false;
    running = safety.run(() => {
      if (disposed || !presence.active() || !shouldRefresh()) return;
      accepted = true; initialized = true;
      return reads.run(({ signal }) => operation({ signal }), { failure: error => { throw error; } });
    }, { intervalMs, manual, initial, source }).finally(() => { running = null; schedule(!accepted); });
    return running;
  };
  const read = () => run(refresh);
  // A person pressing refresh is present by definition: refresh() reads even
  // after the idle cutoff, exactly as before the idle pause. poll() is for a
  // page's own clock and waits while hidden or idle, like the interval itself.
  const manualRead = event => { presence.touch(); return run(refresh, Boolean(event?.isTrusted || window.navigator?.userActivation?.isActive), !initialized); };
  const resumeRead = (invalidate, manual = false) => {
    invalidate?.();
    if (!invalidate || !running) return run(refresh, manual);
    if (queuedResume) return queuedResume;
    reads.invalidate();
    queuedResume = running.then(() => { queuedResume = null; return run(refresh, manual); });
    return queuedResume;
  };
  const visibility = () => { if (document.visibilityState === "hidden") window.clearTimeout?.(timer); };
  document.addEventListener("visibilitychange", visibility);
  const presence = watchPresence({ document, window, onResume: () => resumeRead(onResume), onWake: () => resumeRead(onWake), idleMs, now });
  const online = () => { if (presence.active()) resumeRead(onResume); };
  window.addEventListener("online", online);
  let wasPaused = safety.state().paused;
  const unsubscribe = safety.subscribe(state => {
    if (state.paused) { window.clearTimeout?.(timer); timer = null; }
    else if (wasPaused) schedule();
    wasPaused = state.paused;
  });
  schedule();
  return { refresh: manualRead, revalidate: event => { presence.touch(); return resumeRead(onResume, Boolean(event?.isTrusted || window.navigator?.userActivation?.isActive)); }, poll: read, dispose() { disposed = true; unsubscribe(); safety.cancel(source); reads.dispose(); window.clearTimeout?.(timer); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", online); presence.dispose(); } };
}

export function updatedLabel(value) {
  if (!value) return "Updating…";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? `Updated ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })}` : "Updating…";
}
