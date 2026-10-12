// Read-only background updates. One refresh runs at a time; hidden and idle
// pages sleep (see visibility-poll.mjs). Current-read lifetimes own
// cancellation; page callbacks preserve their local drafts.
import { createCurrentRead } from "./current-read.mjs";
export { readWithDeadline, fetchRead } from "./current-read.mjs";
import { watchPresence } from "./visibility-poll.mjs";

// A failed read retries on a short backoff (1s, 2s, 4s... capped at the
// interval), so "reconnecting" holds within seconds rather than a full poll.
export function mountAutoRefresh({ document, window, refresh, onResume, intervalMs = 30_000, retryMs = 1_000, timeoutMs = 30_000, shouldRefresh = () => true, idleMs, now }) {
  if (!window?.addEventListener || !document?.addEventListener) return { refresh: () => {}, poll: () => {}, dispose: () => {} };
  let timer = null;
  let running = null;
  let queuedResume = null;
  let disposed = false;
  const reads = createCurrentRead({ timeoutMs, clock: window });
  let failures = 0;
  const schedule = () => {
    window.clearTimeout?.(timer);
    const delay = failures ? Math.min(intervalMs, retryMs * 2 ** (failures - 1)) : intervalMs;
    if (!disposed && document.visibilityState !== "hidden" && window.setTimeout) { timer = window.setTimeout(read, delay); timer?.unref?.(); }
  };
  const run = operation => {
    // Idle stops the clock here; the first input re-reads through the resume.
    if (disposed || !presence.active()) return Promise.resolve();
    if (!shouldRefresh()) { schedule(); return Promise.resolve(); }
    if (running) return running;
    window.clearTimeout?.(timer);
    // A read replaced by a resume settles neither way; the queued read decides.
    running = reads.run(({ signal }) => operation({ signal }), {
      success: () => { failures = 0; },
      // Failure stays in the page's own state; the next read comes sooner.
      failure: () => { failures += 1; },
    }).finally(() => { running = null; schedule(); });
    return running;
  };
  const read = () => run(refresh);
  // A person pressing refresh is present by definition: refresh() reads even
  // after the idle cutoff, exactly as before the idle pause. poll() is for a
  // page's own clock and waits while hidden or idle, like the interval itself.
  const manualRead = () => { presence.touch(); return read(); };
  const resumeRead = () => {
    onResume?.();
    if (!onResume || !running) return read();
    if (queuedResume) return queuedResume;
    reads.invalidate();
    queuedResume = running.then(read).finally(() => { queuedResume = null; });
    return queuedResume;
  };
  const visibility = () => { if (document.visibilityState === "hidden") window.clearTimeout?.(timer); };
  document.addEventListener("visibilitychange", visibility);
  const presence = watchPresence({ document, window, onResume: resumeRead, onWake: read, idleMs, now });
  const online = () => { if (presence.active()) resumeRead(); };
  window.addEventListener("online", online);
  schedule();
  return { refresh: manualRead, poll: read, dispose() { disposed = true; reads.dispose(); window.clearTimeout?.(timer); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", online); presence.dispose(); } };
}

export function updatedLabel(value) {
  if (!value) return "Updating…";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? `Updated ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })}` : "Updating…";
}
