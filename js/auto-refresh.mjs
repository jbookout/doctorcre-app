// Read-only background updates. One refresh runs at a time; hidden and idle
// pages sleep (see visibility-poll.mjs). Current-read lifetimes own
// cancellation; page callbacks preserve their local drafts.
import { createCurrentRead } from "./current-read.mjs";
export { readWithDeadline, fetchRead } from "./current-read.mjs";
import { MIN_POLL_MS, mountVisibilityPoll } from "./visibility-poll.mjs";

export function mountAutoRefresh({ document, window, refresh, onResume, onWake, intervalMs = MIN_POLL_MS, timeoutMs = 30_000, shouldRefresh = () => true, idleMs, now, periodic = true }) {
  if (!window?.addEventListener || !document?.addEventListener) return { refresh: () => {}, revalidate: () => {}, poll: () => {}, dispose: () => {} };
  const reads = createCurrentRead({ timeoutMs, clock: window });
  const invalidate = callback => { callback?.(); if (callback) reads.invalidate(); };
  const poller = mountVisibilityPoll({ document, window, intervalMs, idleMs, now, periodic, lifecycle: true, shouldPoll: shouldRefresh,
    onResume: () => invalidate(onResume), onWake: () => invalidate(onWake),
    poll: () => reads.run(({ signal }) => refresh({ signal }), { failure: () => false }) });
  return { refresh: poller.refresh, poll: poller.poll,
    revalidate: poller.revalidate,
    dispose() { reads.dispose(); poller.dispose(); } };
}

export function updatedLabel(value) {
  if (!value) return "Updating…";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? `Updated ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })}` : "Updating…";
}
