// Read-only background updates. One refresh runs at a time; hidden pages sleep.
// Page callbacks own request epochs and preserve their local drafts.
import { mountReadOnResume } from "./read-on-resume.mjs";

export function mountAutoRefresh({ document, window, refresh, onResume = () => {}, intervalMs = 30_000, timeoutMs = 30_000, shouldRefresh = () => true }) {
  if (!window?.addEventListener || !document?.addEventListener) return { refresh: () => {}, dispose: () => {} };
  let timer = null;
  let running = null;
  let disposed = false;
  let controller = null;
  const schedule = () => {
    window.clearTimeout?.(timer);
    if (!disposed && document.visibilityState !== "hidden" && window.setTimeout) { timer = window.setTimeout(read, intervalMs); timer?.unref?.(); }
  };
  const read = () => {
    if (disposed || document.visibilityState === "hidden" || !shouldRefresh()) { schedule(); return Promise.resolve(); }
    if (running) return running;
    window.clearTimeout?.(timer);
    controller = new AbortController();
    running = readWithDeadline(signal => refresh({ signal }), { signal: controller.signal, timeoutMs, clock: window }).catch(() => {
      // Failure stays in the page's own state; the next scheduled read recovers.
    }).finally(() => { running = null; controller = null; schedule(); });
    return running;
  };
  const visibility = () => { if (document.visibilityState === "hidden") window.clearTimeout?.(timer); };
  document.addEventListener("visibilitychange", visibility);
  const resume = mountReadOnResume({ document, window, refresh: () => { onResume(); return read(); } });
  window.addEventListener("online", read);
  schedule();
  return { refresh: read, dispose() { disposed = true; controller?.abort(); window.clearTimeout?.(timer); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", read); resume?.dispose?.(); } };
}

// Bound the whole read, including decoding. A late result from a transport
// that ignores abort never reaches the caller after the deadline wins.
export async function readWithDeadline(read, { timeoutMs = 10_000, signal, clock = globalThis } = {}) {
  const controller = new AbortController();
  let timer, cancel;
  const deadline = new Promise((_, reject) => {
    cancel = () => { const error = new Error("Read timed out or cancelled"); error.code = "read_timeout"; reject(error); controller.abort(); };
    timer = clock.setTimeout(cancel, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
  try { return await (controller.signal.aborted ? deadline : Promise.race([read(controller.signal), deadline])); }
  finally { clock.clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

export function fetchRead(path, init = {}, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  return readWithDeadline(async signal => {
    const response = await fetchImpl(path, { ...init, signal });
    const body = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : body,
      { status: response.status, statusText: response.statusText, headers: response.headers });
  }, { signal: init.signal, timeoutMs });
}

export function updatedLabel(value) {
  if (!value) return "Updating…";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? `Updated ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })}` : "Updating…";
}
