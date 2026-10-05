// Read-only background updates. One refresh runs at a time; hidden pages sleep.
// Current-read lifetimes own cancellation; page callbacks preserve drafts.
import { createCurrentRead } from "./current-read.mjs";
export { readWithDeadline, fetchRead } from "./current-read.mjs";
import { mountReadOnResume } from "./read-on-resume.mjs";

export function mountAutoRefresh({ document, window, refresh, onResume, intervalMs = 30_000, timeoutMs = 30_000, shouldRefresh = () => true }) {
  if (!window?.addEventListener || !document?.addEventListener) return { refresh: () => {}, dispose: () => {} };
  let timer = null;
  let running = null;
  let queuedResume = null;
  let disposed = false;
  const reads = createCurrentRead({ timeoutMs, clock: window });
  const schedule = () => {
    window.clearTimeout?.(timer);
    if (!disposed && document.visibilityState !== "hidden" && window.setTimeout) { timer = window.setTimeout(read, intervalMs); timer?.unref?.(); }
  };
  const run = operation => {
    if (disposed || document.visibilityState === "hidden" || !shouldRefresh()) { schedule(); return Promise.resolve(); }
    if (running) return running;
    window.clearTimeout?.(timer);
    running = reads.run(({ signal }) => operation({ signal })).catch(() => {
      // Failure stays in the page's own state; the next scheduled read recovers.
    }).finally(() => { running = null; schedule(); });
    return running;
  };
  const read = () => run(refresh);
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
  const resume = mountReadOnResume({ document, window, refresh: resumeRead });
  window.addEventListener("online", resumeRead);
  schedule();
  return { refresh: read, dispose() { disposed = true; reads.dispose(); window.clearTimeout?.(timer); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", resumeRead); resume?.dispose?.(); } };
}

export function updatedLabel(value) {
  if (!value) return "Updating…";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? `Updated ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })}` : "Updating…";
}
