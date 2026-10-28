export const POLL_LIMITS = Object.freeze({ gapMs: 5_000, minute: 90, hour: 300, manualMinute: 120, manualHour: 600, failureLimit: 3, backoffMs: 300_000, requestSpacingMs: 20_000, recoveryHour: 30, resumeMs: 3_600_000, reservationMs: 60_000 });
const governors = new WeakMap();

export function createPollSafety({ window, document = window?.document, now = () => window?.Date?.now?.() ?? Date.now(), storage, locks = window?.navigator?.locks } = {}) {
  let nextAt = 0, cooldownAt = 0, lastManual = -Infinity, retryAt = 0, failures = 0, running = null, reason = '';
  let eventNextAt = 0, blockedTriggerUntil = 0;
  const endpointFailures = new Map();
  let sourceFailures = new WeakMap();
  const queue = new Map();
  let queueTimer = null, draining = false;
  const queueClock = window?.setTimeout && window?.clearTimeout ? window : globalThis;
  const requests = { background: [], manual: [], recovery: [] };
  let reservations = new Map();
  const budgets = {
    background: { minute: POLL_LIMITS.minute, hour: POLL_LIMITS.hour },
    manual: { minute: POLL_LIMITS.manualMinute, hour: POLL_LIMITS.manualHour },
    recovery: { minute: POLL_LIMITS.recoveryHour, hour: POLL_LIMITS.recoveryHour },
  };
  let leader = false, acquiring = null, release = null, inFlight = 0, retired = false, pageHidden = false, follower = '';
  let resumeTimer, notice, label, storageFault = false, lastResume = -POLL_LIMITS.resumeMs, recovering = false;
  const storageKey = 'poll-safety-v2';
  try { storage ||= window?.localStorage; }
  catch { storageFault = true; }
  if (!storage && window?.navigator) storageFault = true;
  const restore = () => {
    for (const key of Object.keys(requests)) requests[key] = requests[key].filter(time => time > now() - 3_600_000);
    for (const [id, reservation] of reservations) if (reservation.expiresAt <= now()) reservations.delete(id);
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) || 'null');
      if (!saved) return;
      for (const key of ['background', 'manual', 'recovery']) {
        if (!Array.isArray(saved[key]) || saved[key].length > budgets[key].hour ||
            !saved[key].every(time => Number.isFinite(time) && time >= 0)) throw Error('Invalid budget');
        requests[key] = saved[key].filter(time => time > now() - 3_600_000);
      }
      const held = saved.reservations || [];
      if (!Array.isArray(held) || held.length > POLL_LIMITS.hour + POLL_LIMITS.manualHour + POLL_LIMITS.recoveryHour ||
          !held.every(item => typeof item.id === 'string' && budgets[item.key] && Number.isInteger(item.remaining) && item.remaining > 0 && item.remaining <= budgets[item.key].hour && Number.isFinite(item.expiresAt))) throw Error('Invalid reservation');
      reservations = new Map(held.filter(item => item.expiresAt > now()).map(item => [item.id, item]));
      if (![saved.nextAt, saved.cooldownAt, saved.retryAt, saved.failures, saved.lastResume].every(Number.isFinite) ||
          typeof saved.reason !== 'string' || typeof saved.recovering !== 'boolean') throw Error('Invalid budget');
      nextAt = saved.nextAt; cooldownAt = saved.cooldownAt; retryAt = saved.retryAt; failures = saved.failures;
      reason = saved.reason; lastResume = saved.lastResume; recovering = saved.recovering;
    } catch { storageFault = true; }
    if (storageFault) reason = 'Background updates paused because the request limit could not be restored.';
  };
  restore();
  if (storageFault) reason = 'Background updates paused because browser storage is unavailable.';
  const persist = () => {
    try { storage?.setItem(storageKey, JSON.stringify({ ...requests, reservations: [...reservations.values()], nextAt, cooldownAt, retryAt, failures, reason, lastResume, recovering })); }
    catch { storageFault = true; reason = 'Background updates paused because the request limit could not be saved.'; }
  };
  const transaction = (change, afterSave) => {
    const update = () => {
      restore();
      let result;
      try { result = change(); } finally { persist(); }
      return afterSave ? afterSave(result) : result;
    };
    return locks?.request ? locks.request('doctorcre-poll-budget-v2', { mode: 'exclusive' }, update) : Promise.resolve(update());
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
  const state = () => ({ paused: retired || Boolean(reason), reason: reason || follower, nextAt, resumeAt: Math.max(retryAt, lastResume + POLL_LIMITS.resumeMs, (requests.recovery.at(-1) ?? -POLL_LIMITS.resumeMs) + POLL_LIMITS.resumeMs) });
  const render = () => {
    if (retired || !document?.createElement || !document.body) return;
    if (!notice) {
      notice = document.createElement('section'); notice.dataset.pollSafety = '';
      notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
      notice.style.cssText = 'pointer-events:none;position:fixed;bottom:1rem;left:1rem;right:1rem;z-index:2147483647;padding:1rem;background:var(--surface-1, Canvas);color:var(--fg, CanvasText);border:2px solid currentColor;border-radius:8px';
      label = document.createElement('span');
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.style.pointerEvents = 'auto'; button.textContent = 'Resume updates';
      button.addEventListener('click', event => { if (event.isTrusted) void api.resume(); });
      notice.append(label, button);
    }
    notice.hidden = !reason && !follower;
    if (resumeTimer) queueClock.clearTimeout(resumeTimer);
    const resumeAt = state().resumeAt;
    if (reason && now() < resumeAt) { resumeTimer = queueClock.setTimeout(render, resumeAt - now()); resumeTimer?.unref?.(); }
    const button = notice.querySelector('button');
    button.disabled = now() < resumeAt;
    const text = `${reason || follower}${reason && now() < resumeAt ? ` Updates resume at ${new Date(resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ''} `;
    if (label.textContent !== text) label.textContent = text;
    const parent = !notice.hidden && (document.activeElement?.closest?.('dialog[open], aside:not([inert]), [role="dialog"]') || [...(document.querySelectorAll?.('dialog[open]') || [])].at(-1)) || document.body;
    if (notice.inert) notice.inert = false;
    if (notice.parentNode !== parent) parent.append(notice);
  };
  const notify = () => { render(); listeners.forEach(listener => listener(state())); pump(); };
  const blocked = () => Object.assign(new Error(reason || 'Updates are rate limited. Try again shortly.'), { code: 'poll_paused' });
  const backoff = (count, intervalMs) => Math.max(intervalMs, Math.min(POLL_LIMITS.backoffMs, intervalMs * 2 ** count));
  const fail = async (count, intervalMs, retryUntil = 0) => {
    await transaction(() => {
      retryAt = Math.max(retryAt, retryUntil);
      failures = count;
      cooldownAt = Math.max(cooldownAt, now() + backoff(count, intervalMs), retryAt);
      nextAt = Math.max(nextAt, cooldownAt);
      if (count >= POLL_LIMITS.failureLimit) reason = 'Background updates paused after repeated failures.';
    });
    notify();
  };
  const endpoint = (path, init) => {
    let verb = '';
    try { verb = JSON.parse(init?.body).params?.name || ''; } catch {}
    return `${String(path).split('?')[0]}:${verb}`;
  };
  const transportFailure = async (cycle, key, response) => {
    let retryUntil = 0;
    const retry = response?.headers?.get?.('Retry-After');
    if (retry) {
      const delay = /^\d+(\.\d+)?$/.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry) - now();
      if (Number.isFinite(delay)) retryUntil = now() + Math.max(0, delay);
    }
    const count = (endpointFailures.get(key) || 0) + 1;
    endpointFailures.set(key, count);
    if (cycle) cycle.failed = true;
    await fail(Math.max(count, cycle ? failures + 1 : 0), cycle?.intervalMs || 30_000, retryUntil);
  };
  const manualIntent = () => {
    if (running?.invoking) return running.manual;
    const event = window?.event;
    if (event?.isTrusted && ['click', 'submit', 'keydown', 'pointerdown'].includes(event.type)) return true;
    return running ? running.manual : !eventContext;
  };
  async function execute(operation, { manual = false, intervalMs = 30_000, keepAlive = false, initial = false, source } = {}) {
    restore();
    if (running && initial) return running.done.then(() => execute(operation, { manual, intervalMs, keepAlive, initial, source }));
    if (retired || running || now() < retryAt || (manual
      ? !initial && now() < lastManual + POLL_LIMITS.gapMs
      : reason || (!initial && now() < Math.max(cooldownAt, nextAt)))) return;
    let finish;
    const cycle = { manual, intervalMs, keepAlive, invoking: false, admitted: false, failed: false, done: new Promise(resolve => { finish = resolve; }) };
    running = cycle;
    if (manual) lastManual = now();
    try {
      if (!manual) {
        if (!await acquire()) return;
        const admitted = await transaction(() => {
          if (reason || (!initial && now() < Math.max(cooldownAt, nextAt))) return false;
          nextAt = Math.max(nextAt, now() + POLL_LIMITS.gapMs);
          return true;
        });
        if (!admitted) return;
      }
      cycle.admitted = true;
      let result;
      cycle.invoking = true;
      try { result = operation(); } finally { cycle.invoking = false; }
      return await result;
    }
    catch (error) { if (error?.code !== 'poll_paused') cycle.failed = true; }
    finally {
      if (!manual && cycle.admitted) {
        if (cycle.failed) {
          failures = (source ? sourceFailures.get(source) || 0 : failures) + 1;
          if (source) sourceFailures.set(source, failures);
          await fail(failures, intervalMs);
        } else { failures = 0; if (source) sourceFailures.delete(source); }
      }
      if (running === cycle) running = null;
      relinquish(); finish(); pump();
    }
  }
  const readyAt = ({ manual = false, initial = false }) => Math.max(retryAt,
    manual ? initial ? 0 : lastManual + POLL_LIMITS.gapMs : initial ? 0 : Math.max(cooldownAt, nextAt));
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
    transport(fetchImpl, slots = 1, { manual = manualIntent() } = {}) {
      const reservation = { id: globalThis.crypto.randomUUID(), manual, started: false, blockedTrigger: !manual && now() < blockedTriggerUntil };
      const transport = (path, init) => api.fetch(fetchImpl, path, init, { manual: reservation.manual, reservation, slots });
      transport.release = () => transaction(() => { reservations.delete(reservation.id); });
      return transport;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    run(operation, options = {}) {
      restore();
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
      sourceFailures.delete(source);
      const job = queue.get(source);
      if (job && !job.started) { queue.delete(source); job.resolve(); pump(); }
    },
    async fetch(fetchImpl, path, init, { manual = manualIntent(), reservation, slots = 1, blockedTrigger = reservation?.blockedTrigger ?? now() < blockedTriggerUntil } = {}) {
      const cycle = running;
      if (!manual && !await acquire()) throw blocked();
      const sent = await transaction(() => {
        let held = reservation?.started ? reservations.get(reservation.id) : null;
        if (reservation?.started && !held) throw blocked();
        if (retired || now() < retryAt || (!manual && !held && (storageFault || blockedTrigger || reason || (!cycle && now() < cooldownAt)))) throw blocked();
        if (recovering && now() >= lastResume + POLL_LIMITS.resumeMs && !requests.background.length) recovering = false;
        const key = held?.key || (manual ? 'manual' : recovering ? 'recovery' : 'background');
        const times = requests[key] = requests[key].filter(time => time > now() - 3_600_000);
        if (!held) {
          const reserved = [...reservations.values()].filter(item => item.key === key).reduce((total, item) => total + item.remaining, 0);
          const budget = budgets[key];
          if (times.length + reserved + slots > budget.hour || times.filter(time => time > now() - 60_000).length + reserved + slots > budget.minute) {
            if (!manual) { reason = 'Background updates paused after reaching the request limit.'; notify(); }
            throw blocked();
          }
          if (reservation) {
            held = { id: reservation.id, key, remaining: slots, expiresAt: now() + POLL_LIMITS.reservationMs };
            reservations.set(held.id, held); reservation.started = true;
          }
        }
        if (held && --held.remaining === 0) reservations.delete(held.id);
        times.push(now());
        if (!manual) nextAt = Math.max(nextAt, now()) + POLL_LIMITS.requestSpacingMs;
      }, () => {
        if (!manual && storageFault) { notify(); throw blocked(); }
        inFlight++;
        let response;
        try { response = Promise.resolve(fetchImpl(path, init)); }
        catch (error) { response = Promise.reject(error); }
        response.catch(() => {});
        return { response };
      });
      const keyPath = endpoint(path, init);
      try {
        const response = await sent.response;
        if (response.status === 429 || response.status >= 500) await transportFailure(cycle, keyPath, response);
        else endpointFailures.delete(keyPath);
        return response;
      } catch (error) {
        if (error?.code !== 'poll_paused' && !init?.signal?.aborted) await transportFailure(cycle, keyPath);
        throw error;
      } finally { inFlight--; relinquish(); }
    },
    async resume() {
      await transaction(() => {
        if (storageFault || !reason || now() < state().resumeAt || requests.recovery.length >= POLL_LIMITS.recoveryHour) return;
        const held = [...reservations.values()].filter(item => item.key === 'background').reduce((total, item) => total + item.remaining, 0);
        const available = Math.min(POLL_LIMITS.hour - requests.background.length, POLL_LIMITS.minute - requests.background.filter(time => time > now() - 60_000).length) - held;
        lastResume = now(); recovering = available < POLL_LIMITS.recoveryHour; reason = ''; failures = 0; nextAt = now(); cooldownAt = now();
        endpointFailures.clear(); sourceFailures = new WeakMap();
      });
      notify();
    },
    dispose() { window?.removeEventListener?.('doctorcre-session-invalidated', retire); observer?.disconnect(); document?.removeEventListener?.('focusin', render); window?.removeEventListener?.('storage', storageChanged); retired = true; if (resumeTimer) queueClock.clearTimeout(resumeTimer); for (const job of queue.values()) job.resolve(); queue.clear(); if (queueTimer !== null) queueClock.clearTimeout(queueTimer); queueTimer = null; listeners.clear(); document?.removeEventListener?.('visibilitychange', captureTrigger, true); window?.removeEventListener?.('online', captureTrigger, true); window?.removeEventListener?.('pageshow', captureTrigger, true); document?.removeEventListener?.('visibilitychange', relinquish); window?.removeEventListener?.('pagehide', pagehide); window?.removeEventListener?.('pageshow', pageshow); relinquish(); notice?.remove(); },
  };
  const retire = () => api.dispose();
  window?.addEventListener?.('doctorcre-session-invalidated', retire);
  let eventContext = false;
  const captureTrigger = event => {
    if (event.type === 'visibilitychange' && document?.visibilityState === 'hidden') return;
    if (event.type === 'pageshow' && !event.persisted) return;
    eventContext = true;
    queueMicrotask(() => { eventContext = false; });
    const ready = Math.max(nextAt, eventNextAt);
    if (now() >= ready) eventNextAt = now() + POLL_LIMITS.gapMs;
    else blockedTriggerUntil = Math.max(blockedTriggerUntil, ready);
  };
  document?.addEventListener?.('visibilitychange', captureTrigger, true);
  window?.addEventListener?.('online', captureTrigger, true);
  window?.addEventListener?.('pageshow', captureTrigger, true);
  const pagehide = () => { pageHidden = true; relinquish(); };
  const pageshow = () => { pageHidden = false; };
  document?.addEventListener?.('visibilitychange', relinquish);
  window?.addEventListener?.('pagehide', pagehide);
  window?.addEventListener?.('pageshow', pageshow);
  const observer = document?.body && window?.MutationObserver ? new window.MutationObserver(render) : null;
  observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'inert'] });
  document?.addEventListener?.('focusin', render);
  const storageChanged = event => { if (event.key === storageKey) { restore(); notify(); } };
  window?.addEventListener?.('storage', storageChanged);
  render();
  return api;
}

export function pollSafety(window = globalThis.window, options = {}) {
  if (!window) return null;
  if (!governors.has(window)) governors.set(window, createPollSafety({ window, ...options }));
  return governors.get(window);
}
