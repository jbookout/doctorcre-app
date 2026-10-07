// Read-only background updates. One refresh runs at a time; hidden pages sleep.
// Page callbacks own request epochs and preserve their local drafts.
import { mountReadOnResume } from "./read-on-resume.mjs";

// A failed read retries on a short backoff (1s, 2s, 4s... capped at the
// interval), so "reconnecting" holds within seconds rather than a full poll.
export function mountAutoRefresh({ document, window, refresh, onResume, intervalMs = 30_000, retryMs = 1_000, timeoutMs = 30_000, shouldRefresh = () => true }) {
  if (!window?.addEventListener || !document?.addEventListener) return { refresh: () => {}, dispose: () => {} };
  let timer = null;
  let running = null;
  let queuedResume = null;
  let disposed = false;
  let controller = null;
  let failures = 0;
  const schedule = () => {
    window.clearTimeout?.(timer);
    const delay = failures ? Math.min(intervalMs, retryMs * 2 ** (failures - 1)) : intervalMs;
    if (!disposed && document.visibilityState !== "hidden" && window.setTimeout) { timer = window.setTimeout(read, delay); timer?.unref?.(); }
  };
  const run = operation => {
    if (disposed || document.visibilityState === "hidden" || !shouldRefresh()) { schedule(); return Promise.resolve(); }
    if (running) return running;
    window.clearTimeout?.(timer);
    controller = new AbortController();
    running = readWithDeadline(signal => operation({ signal }), { signal: controller.signal, timeoutMs, clock: window }).then(() => { failures = 0; }, () => {
      // Failure stays in the page's own state; the next read comes sooner.
      failures += 1;
    }).finally(() => { running = null; controller = null; schedule(); });
    return running;
  };
  const read = () => run(refresh);
  const resumeRead = () => {
    onResume?.();
    if (!onResume || !running) return read();
    if (queuedResume) return queuedResume;
    controller?.abort();
    queuedResume = running.then(read).finally(() => { queuedResume = null; });
    return queuedResume;
  };
  const visibility = () => { if (document.visibilityState === "hidden") window.clearTimeout?.(timer); };
  document.addEventListener("visibilitychange", visibility);
  const resume = mountReadOnResume({ document, window, refresh: resumeRead });
  window.addEventListener("online", resumeRead);
  schedule();
  return { refresh: read, dispose() { disposed = true; controller?.abort(); window.clearTimeout?.(timer); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", resumeRead); resume?.dispose?.(); } };
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
