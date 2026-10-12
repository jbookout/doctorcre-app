// One accepted answer per lifetime. Cancellation fences callbacks even when
// a transport ignores abort; page-specific state belongs to success/failure.
export function createCurrentRead({ timeoutMs = 30_000, clock = globalThis } = {}) {
  let active = null;
  let disposed = false;
  const stale = Symbol('obsolete read');
  const invalidate = () => { active?.abort(); active = null; };
  return {
    invalidate,
    dispose() { disposed = true; invalidate(); },
    async run(operation, { success, failure, signal } = {}) {
      invalidate();
      if (disposed) return;
      const controller = new AbortController();
      active = controller;
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        const value = await readWithDeadline(currentSignal => operation({
          signal: currentSignal,
          // Check at each awaited leg, before an obsolete operation can start
          // its next leg. No caller receives or compares sequence numbers.
          async read(promise) {
            const value = await promise;
            if (active !== controller || currentSignal.aborted) throw stale;
            return value;
          },
        }), { signal: controller.signal, timeoutMs, clock });
        if (active === controller && !controller.signal.aborted) return success ? success(value) : value;
      } catch (error) {
        if (active !== controller || controller.signal.aborted || error === stale) return;
        if (failure) return failure(error);
        throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
        if (active === controller) active = null;
      }
    },
  };
}

// Bound the whole read, including decoding. A late result from a transport
// that ignores abort never reaches the caller after the deadline wins.
export async function readWithDeadline(read, { timeoutMs = 10_000, signal, clock = globalThis } = {}) {
  const controller = new AbortController();
  let timer, cancel;
  const deadline = new Promise((_, reject) => {
    cancel = () => { const error = new Error('Read timed out or cancelled'); error.code = 'read_timeout'; reject(error); controller.abort(); };
    timer = clock.setTimeout(cancel, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
  try { return await (controller.signal.aborted ? deadline : Promise.race([read(controller.signal), deadline])); }
  finally { clock.clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

export function fetchRead(path, init = {}, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  return readWithDeadline(async signal => {
    const response = await fetchImpl(path, { ...init, signal });
    const body = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : body,
      { status: response.status, statusText: response.statusText, headers: response.headers });
  }, { signal: init.signal, timeoutMs });
}
