const pages = new WeakMap();
const cancelled = () => Object.assign(new Error('Read timed out or cancelled'), { code: 'read_timeout' });

// Existing subscribers may finish, but a read after a write needs a new snapshot.
export function separatePageReads(transport) {
  pages.get(globalThis.document || globalThis)?.transports.delete(transport);
}

// Share only unfinished reads. Each subscriber owns its cancellation and copy.
export function sharedPageRead(transport, key, operation, signal) {
  if (signal?.aborted) return Promise.reject(cancelled());
  const document = globalThis.document;
  const owner = document || globalThis;
  let page = pages.get(owner);
  if (!page) {
    page = { transports: new WeakMap(), active: new Set() };
    pages.set(owner, page);
    const invalidate = () => {
      for (const entry of [...page.active]) entry.cancel();
    };
    document?.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') invalidate(); });
    for (const name of ['pagehide', 'offline', 'doctorcre-session-invalidated']) globalThis.window?.addEventListener(name, invalidate);
    globalThis.window?.addEventListener('pageshow', event => { if (event.persisted) invalidate(); });
  }
  let pending = page.transports.get(transport);
  if (!pending) { pending = new Map(); page.transports.set(transport, pending); }
  let entry = pending.get(key);
  if (!entry) {
    const controller = new AbortController(), subscribers = new Set();
    const remove = () => { if (pending.get(key) === entry) pending.delete(key); page.active.delete(entry); };
    const settle = (method, value) => {
      remove();
      for (const subscriber of [...subscribers]) subscriber[method](value);
    };
    entry = { controller, subscribers, cancel() { remove(); controller.abort(); settle('reject', cancelled()); } };
    pending.set(key, entry); page.active.add(entry);
    Promise.resolve(operation(controller.signal)).then(value => settle('resolve', value), error => settle('reject', error));
  }
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      signal?.removeEventListener('abort', abort);
      entry.subscribers.delete(subscriber);
      callback(value);
    };
    const abort = () => {
      if (pending.get(key) === entry) pending.delete(key);
      finish(reject, cancelled());
      if (!entry.subscribers.size) entry.cancel();
    };
    const subscriber = { resolve: value => finish(resolve, structuredClone(value)), reject: error => finish(reject, error) };
    entry.subscribers.add(subscriber);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
