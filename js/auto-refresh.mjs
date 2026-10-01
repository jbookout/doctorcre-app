// Read-only background updates. One refresh runs at a time; hidden pages sleep.
// Page callbacks own request epochs and preserve their local drafts.
import { mountReadOnResume } from "./read-on-resume.mjs";

export function mountAutoRefresh({ document, window, refresh, intervalMs = 30_000, shouldRefresh = () => true }) {
  if (!window?.addEventListener || !document?.addEventListener) return { refresh: () => {}, dispose: () => {} };
  let timer = null;
  let running = null;
  let disposed = false;
  const schedule = () => {
    window.clearTimeout?.(timer);
    if (!disposed && document.visibilityState !== "hidden" && window.setTimeout) { timer = window.setTimeout(read, intervalMs); timer?.unref?.(); }
  };
  const read = () => {
    if (disposed || document.visibilityState === "hidden" || !shouldRefresh()) { schedule(); return Promise.resolve(); }
    if (running) return running;
    window.clearTimeout?.(timer);
    running = Promise.resolve().then(refresh).catch(() => {
      // Failure stays in the page's own state; the next scheduled read recovers.
    }).finally(() => { running = null; schedule(); });
    return running;
  };
  const visibility = () => { if (document.visibilityState === "hidden") window.clearTimeout?.(timer); };
  document.addEventListener("visibilitychange", visibility);
  const resume = mountReadOnResume({ document, window, refresh: read });
  window.addEventListener("online", read);
  schedule();
  return { refresh: read, dispose() { disposed = true; window.clearTimeout?.(timer); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", read); resume?.dispose?.(); } };
}

export function updatedLabel(value) {
  if (!value) return "Updating…";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? `Updated ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })}` : "Updating…";
}
