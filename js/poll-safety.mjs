export const POLL_LIMITS = Object.freeze({ gapMs: 5_000, minute: 60, hour: 300, manualMinute: 30, manualHour: 120, failureLimit: 3, backoffMs: 300_000 });
const governors = new WeakMap();

export function createPollSafety({ window, document = window?.document, now = () => Date.now(), storage, locks = window?.navigator?.locks } = {}) {
  let nextAt = 0, cooldownAt = 0, lastManual = -Infinity, retryAt = 0, failures = 0, running = null, reason = '';
  const endpointFailures = new Map();
  const queue = new Map();
  let queueTimer = null, draining = false;
  const queueClock = window?.setTimeout && window?.clearTimeout ? window : globalThis;
  const requests = { background: [], manual: [] };
  const reservations = new Set();
  const reserved = manual => [...reservations].filter(item => item.manual === manual).reduce((total, item) => total + item.remaining, 0);
  let leader = false, acquiring = null, release = null, inFlight = 0, retired = false, pageHidden = false, follower = '', lastResume = -Infinity;
  let notice, label, storageFault = false;
  const storageKey = 'poll-safety-v1';
  try {
    storage ||= window?.sessionStorage;
    if (!storage && window?.navigator) { storageFault = true; reason = 'Background updates paused because browser storage is unavailable.'; }
    const saved = JSON.parse(storage?.getItem(storageKey) || 'null');
    if (saved) {
      if (!Array.isArray(saved.background) || !Array.isArray(saved.manual) ||
          saved.background.length > POLL_LIMITS.hour || saved.manual.length > POLL_LIMITS.manualHour ||
          ![...saved.background, ...saved.manual, saved.nextAt, saved.cooldownAt, saved.retryAt, saved.failures].every(value => Number.isFinite(value) && value >= 0) ||
          !Number.isInteger(saved.failures) || saved.failures > POLL_LIMITS.failureLimit || typeof saved.reason !== 'string' || saved.reason.length > 300) throw Error('Invalid budget');
      requests.background = saved.background.filter(time => time > now() - 3_600_000);
      requests.manual = saved.manual.filter(time => time > now() - 3_600_000);
      nextAt = saved.nextAt; cooldownAt = saved.cooldownAt; retryAt = saved.retryAt; failures = saved.failures; reason = saved.reason;
    }
  } catch { storageFault = true; reason = 'Background updates paused because the request limit could not be restored.'; }
  const persist = () => {
    try { storage?.setItem(storageKey, JSON.stringify({ background: [...requests.background, ...Array(reserved(false)).fill(now())], manual: [...requests.manual, ...Array(reserved(true)).fill(now())], nextAt, cooldownAt, retryAt, failures, reason })); }
    catch { storageFault = true; reason = 'Background updates paused because the request limit could not be saved.'; }
  };
  const hidden = () => pageHidden || document?.visibilityState === 'hidden';
  const relinquish = () => {
    if ((retired || hidden()) && !running && !inFlight) { release?.(); release = null; leader = false; }
  };
  const acquire = async () => {
    if (retired || (hidden() && !running?.keepAlive)) return false;
    if (!window?.navigator && !locks) return true;
    if (!locks?.request) { reason = 'Background updates paused because this browser cannot coordinate tabs.'; notify(); return false; }
    if (leader) return true;
    if (acquiring) return acquiring;
    acquiring = new Promise(resolve => {
      try {
        Promise.resolve(locks.request('doctorcre-background-poll-v1', { mode: 'exclusive', ifAvailable: true }, lock => {
          if (!lock || retired || (hidden() && !running?.keepAlive)) {
            follower = 'Background updates are waiting for another tab.'; notify(); resolve(false); return;
          }
          leader = true; follower = ''; resolve(true); notify();
          return new Promise(done => { release = done; });
        })).catch(() => { reason = 'Background updates paused because tab coordination failed.'; notify(); resolve(false); });
      } catch { reason = 'Background updates paused because tab coordination failed.'; notify(); resolve(false); }
    });
    try { return await acquiring; } finally { acquiring = null; }
  };
  const listeners = new Set();
  const state = () => ({ paused: Boolean(reason), reason: reason || follower, nextAt });
  const render = () => {
    if (!document?.createElement || !document.body) return;
    if (!notice) {
      notice = document.createElement('section'); notice.dataset.pollSafety = '';
      notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
      notice.style.cssText = 'position:fixed;bottom:1rem;left:1rem;right:1rem;z-index:2147483647;padding:1rem;background:var(--surface, Canvas);color:var(--text, CanvasText);border:2px solid currentColor;border-radius:8px';
      label = document.createElement('span');
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Resume updates';
      button.addEventListener('click', event => { if (event.isTrusted) api.resume(); });
      notice.append(label, button); document.body.append(notice);
    }
    notice.hidden = !reason && !follower;
    label.textContent = `${reason || follower} `;
  };
  const notify = () => { persist(); render(); listeners.forEach(listener => listener(state())); pump(); };
  const blocked = () => Object.assign(new Error(reason || 'Updates are rate limited. Try again shortly.'), { code: 'poll_paused' });
  const backoff = (count, intervalMs) => Math.max(intervalMs, Math.min(POLL_LIMITS.backoffMs, intervalMs * 2 ** count));
  const fail = (count, intervalMs) => {
    cooldownAt = Math.max(cooldownAt, now() + backoff(count, intervalMs), retryAt);
    nextAt = Math.max(nextAt, cooldownAt);
    if (count >= POLL_LIMITS.failureLimit) reason = 'Background updates paused after repeated failures.';
    notify();
  };
  const endpoint = (path, init) => {
    let verb = '';
    try { verb = JSON.parse(init?.body).params?.name || ''; } catch {}
    return `${String(path).split('?')[0]}:${verb}`;
  };
  const transportFailure = (cycle, key, response) => {
    const retry = response?.headers?.get?.('Retry-After');
    if (retry) {
      const delay = /^\d+(\.\d+)?$/.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry) - now();
      if (Number.isFinite(delay)) retryAt = Math.max(retryAt, now() + Math.max(0, delay));
    }
    const count = (endpointFailures.get(key) || 0) + 1;
    endpointFailures.set(key, count);
    if (cycle) cycle.failed = true;
    fail(Math.max(count, cycle ? failures + 1 : 0), cycle?.intervalMs || 30_000);
  };
  const manualIntent = () => running ? running.manual : window?.navigator?.userActivation?.isActive === true;
  async function execute(operation, { manual = false, intervalMs = 30_000, keepAlive = false, initial = false } = {}) {
    if (running && initial) return running.done.then(() => execute(operation, { manual, intervalMs, keepAlive, initial }));
    if (running || now() < retryAt || (manual
      ? !initial && now() < lastManual + POLL_LIMITS.gapMs
      : reason || now() < cooldownAt || (!initial && now() < nextAt))) return;
    let finish;
    const cycle = { manual, intervalMs, keepAlive, admitted: false, failed: false, done: new Promise(resolve => { finish = resolve; }) };
    running = cycle;
    if (manual) lastManual = now();
    nextAt = Math.max(nextAt, now() + POLL_LIMITS.gapMs);
    try {
      if (!manual && !await acquire()) return;
      cycle.admitted = true;
      return await operation();
    }
    catch (error) { if (error?.code !== 'poll_paused') cycle.failed = true; }
    finally {
      if (!manual && cycle.admitted) {
        if (cycle.failed) fail(++failures, intervalMs);
        else failures = 0;
      }
      if (running === cycle) running = null;
      persist(); relinquish(); finish(); pump();
    }
  }
  const readyAt = ({ manual = false, initial = false }) => Math.max(retryAt,
    manual ? initial ? 0 : lastManual + POLL_LIMITS.gapMs : Math.max(cooldownAt, initial ? 0 : nextAt));
  function pump() {
    if (queueTimer !== null) { queueClock.clearTimeout(queueTimer); queueTimer = null; }
    if (draining || running) return;
    const manual = [...queue].find(([, job]) => job.options.manual);
    const entries = manual && readyAt(manual[1].options) <= now()
      ? [manual, ...[...queue].filter(([source]) => source !== manual[0])] : queue;
    for (const [source, job] of entries) {
      if (retired || (!job.options.manual && reason)) { queue.delete(source); job.resolve(); continue; }
      const at = readyAt(job.options);
      if (now() < at) {
        const next = manual ? Math.min(at, readyAt(manual[1].options)) : at;
        queueTimer = queueClock.setTimeout(pump, next - now()); queueTimer?.unref?.();
        return;
      }
      job.started = true; draining = true;
      execute(job.operation, job.options).then(job.resolve, job.reject).finally(() => { queue.delete(source); draining = false; pump(); });
      return;
    }
  }
  const api = {
    state,
    transport(fetchImpl, slots = 1) {
      const reservation = { manual: manualIntent(), remaining: 0 };
      const transport = (path, init) => api.fetch(fetchImpl, path, init, { manual: reservation.manual, reservation, slots });
      transport.release = () => { reservations.delete(reservation); persist(); };
      return transport;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    run(operation, options = {}) {
      const { source, manual = false } = options;
      if (!source) return execute(operation, options);
      if (queue.has(source)) { if (manual) api.promote(source); return queue.get(source).promise; }
      if (retired || (!manual && reason)) return Promise.resolve();
      let resolve, reject;
      const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
      const job = { operation, options, started: false, promise, resolve, reject };
      queue.set(source, job); pump();
      return job.promise;
    },
    promote(source) {
      const job = queue.get(source);
      if (job && !job.started) { job.options = { ...job.options, manual: true, initial: false }; pump(); }
    },
    cancel(source) {
      const job = queue.get(source);
      if (job && !job.started) { queue.delete(source); job.resolve(); pump(); }
    },
    async fetch(fetchImpl, path, init, { manual = manualIntent(), reservation, slots = 1 } = {}) {
      const cycle = running;
      if (retired || now() < retryAt || (!manual && !reservation?.remaining && (reason || (!cycle && now() < cooldownAt)))) throw blocked();
      if (!manual && !await acquire()) throw blocked();
      const key = manual ? 'manual' : 'background';
      const times = requests[key] = requests[key].filter(time => time > now() - 3_600_000);
      const needed = reservation?.remaining ? 0 : slots;
      if (times.length + reserved(manual) + needed > (manual ? POLL_LIMITS.manualHour : POLL_LIMITS.hour) ||
          times.filter(time => time > now() - 60_000).length + reserved(manual) + needed > (manual ? POLL_LIMITS.manualMinute : POLL_LIMITS.minute)) {
        if (!manual) { reason = 'Background updates paused after reaching the request limit.'; notify(); }
        throw blocked();
      }
      if (reservation) {
        if (!reservation.remaining) { reservation.remaining = slots; reservations.add(reservation); }
        reservation.remaining--;
        if (!reservation.remaining) reservations.delete(reservation);
      }
      times.push(now()); persist();
      if (!manual && storageFault) { notify(); throw blocked(); }
      inFlight++;
      const keyPath = endpoint(path, init);
      try {
        const response = await fetchImpl(path, init);
        if (response.status === 429 || response.status >= 500) transportFailure(cycle, keyPath, response);
        else endpointFailures.delete(keyPath);
        return response;
      } catch (error) {
        if (error?.code !== 'poll_paused' && !init?.signal?.aborted) transportFailure(cycle, keyPath);
        throw error;
      } finally { inFlight--; persist(); relinquish(); }
    },
    resume() {
      if (storageFault || now() < lastResume + POLL_LIMITS.gapMs) return;
      lastResume = now(); reason = ''; failures = 0; endpointFailures.clear(); notify();
    },
    dispose() { retired = true; for (const job of queue.values()) job.resolve(); queue.clear(); if (queueTimer !== null) queueClock.clearTimeout(queueTimer); queueTimer = null; listeners.clear(); document?.removeEventListener?.('visibilitychange', relinquish); window?.removeEventListener?.('pagehide', pagehide); window?.removeEventListener?.('pageshow', pageshow); relinquish(); notice?.remove(); },
  };
  const pagehide = () => { pageHidden = true; relinquish(); };
  const pageshow = () => { pageHidden = false; };
  document?.addEventListener?.('visibilitychange', relinquish);
  window?.addEventListener?.('pagehide', pagehide);
  window?.addEventListener?.('pageshow', pageshow);
  render();
  return api;
}

export function pollSafety(window = globalThis.window, options = {}) {
  if (!window) return null;
  if (!governors.has(window)) governors.set(window, createPollSafety({ window, ...options }));
  return governors.get(window);
}
