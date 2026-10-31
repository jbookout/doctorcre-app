// Read-only background updates. One refresh runs at a time; hidden and idle
// pages sleep (see visibility-poll.mjs). Current-read lifetimes own
// cancellation; page callbacks preserve their local drafts.
import { createCurrentRead } from "./current-read.mjs";
export { readWithDeadline, fetchRead } from "./current-read.mjs";
import { MAX_BACKOFF_MS, MAX_POLL_ATTEMPTS, MIN_POLL_MS, watchPresence } from "./visibility-poll.mjs";

export function mountAutoRefresh({ document, window, refresh, onResume, onWake, intervalMs: askedMs = MIN_POLL_MS, timeoutMs = 30_000, shouldRefresh = () => true, idleMs, now }) {
  if (!window?.addEventListener || !document?.addEventListener) return { refresh: () => {}, revalidate: () => {}, poll: () => {}, dispose: () => {} };
  const intervalMs = Math.max(MIN_POLL_MS, askedMs);
  let timer = null;
  let running = null;
  let queuedResume = null;
  let disposed = false;
  let attempts = 0;
  let failures = 0;
  const reads = createCurrentRead({ timeoutMs, clock: window });
  const schedule = () => {
    window.clearTimeout?.(timer);
    if (!disposed && presence.active() && attempts < MAX_POLL_ATTEMPTS && window.setTimeout) { timer = window.setTimeout(read, Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.max(failures, Math.floor(attempts / 5)))); timer?.unref?.(); }
  };
  const run = operation => {
    // Idle stops the clock here; the first input re-reads through the resume.
    if (disposed || !presence.active() || attempts >= MAX_POLL_ATTEMPTS) return Promise.resolve();
    if (!shouldRefresh()) { attempts++; schedule(); return Promise.resolve(); }
    if (running) return running;
    window.clearTimeout?.(timer);
    attempts++;
    running = reads.run(({ signal }) => operation({ signal }), {
      success: value => { failures = value === false ? failures + 1 : 0; return value; },
      failure: () => { failures++; },
    }).finally(() => { running = null; schedule(); });
    return running;
  };
  const read = () => run(refresh);
  // A person pressing refresh is present by definition: refresh() reads even
  // after the idle cutoff, exactly as before the idle pause. poll() is for a
  // page's own clock and waits while hidden or idle, like the interval itself.
  const manualRead = () => { attempts = 0; failures = 0; presence.touch(); return read(); };
  const resumeRead = invalidate => {
    invalidate?.();
    if (!invalidate || !running) return read();
    if (queuedResume) return queuedResume;
    reads.invalidate();
    queuedResume = running.then(() => { queuedResume = null; return read(); });
    return queuedResume;
  };
  const visibility = () => { if (document.visibilityState === "hidden") window.clearTimeout?.(timer); };
  document.addEventListener("visibilitychange", visibility);
  const restart = invalidate => { attempts = 0; failures = 0; return resumeRead(invalidate); };
  const presence = watchPresence({ document, window, onResume: () => restart(onResume), onWake: () => restart(onWake), onInput: () => { if (attempts >= MAX_POLL_ATTEMPTS) restart(); }, idleMs, now });
  const online = () => { if (presence.active()) resumeRead(onResume); };
  window.addEventListener("online", online);
  schedule();
  return { refresh: manualRead, revalidate: () => { presence.touch(); return resumeRead(onResume); }, poll: read, dispose() { disposed = true; reads.dispose(); window.clearTimeout?.(timer); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", online); presence.dispose(); } };
}

export function updatedLabel(value) {
  if (!value) return "Updating…";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? `Updated ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })}` : "Updating…";
}
