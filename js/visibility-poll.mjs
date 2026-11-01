// Clocks and lifecycle refreshes stop when hidden or thirty minutes idle.
// Trusted human input renews presence; lifecycle events and scrolling do not.
// A live-call exception may run hidden, within the same hard attempt cap.
import { mountReadOnResume } from "./read-on-resume.mjs";

export const IDLE_CUTOFF_MS = 30 * 60_000;
// Periodic reads run at most once a minute; healthy lifecycle refreshes
// share their attempt cap and begin backing off after five attempts.
export const MIN_POLL_MS = 60_000;
export const MAX_POLL_ATTEMPTS = 20;
export const MAX_BACKOFF_MS = 15 * 60_000;
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "touchstart", "touchmove", "wheel"];

// Scroll events are also dispatched for scrollIntoView and restored scroll.
// Pointer, touch, wheel and keyboard input establish user presence instead.
export function listenForHumanInput(document, callback) {
  const options = { capture: true, passive: true };
  const input = event => { if (event.isTrusted === true) callback(event); };
  // eslint-disable-next-line no-restricted-syntax -- Registers only the finite INPUT_EVENTS list; trusted input renews presence, and this callback performs 0 reads.
  INPUT_EVENTS.forEach(type => document?.addEventListener(type, input, options));
  return () => INPUT_EVENTS.forEach(type => document?.removeEventListener?.(type, input, options));
}

export function watchPresence({ document, window, onResume, onWake, onInput = () => {}, idleMs = IDLE_CUTOFF_MS, now = () => Date.now() }) {
  let lastInput = now();
  const hidden = () => document.visibilityState === "hidden";
  const idle = () => now() - lastInput >= idleMs;
  const active = () => !hidden() && !idle();
  const stopInput = listenForHumanInput(document, () => {
    const waking = idle() && !hidden();
    lastInput = now();
    if (waking) onWake();
    else if (!hidden()) onInput();
  });
  const resume = mountReadOnResume({ document, window, refresh: () => { if (active()) return onResume(); } });
  return { active, dispose() { resume.dispose(); stopInput(); } };
}

// All automatic clocks and lifecycle signals share one attempt counter and
// one next-read deadline. Only trusted input can grant another presence period.
export function mountVisibilityPoll({
  poll, intervalMs = MIN_POLL_MS, keepAlive = () => false, idleMs, now = () => Date.now(),
  document = globalThis.document, window = globalThis, periodic = true, lifecycle = false, shouldPoll = () => true,
  onResume = () => {}, onWake = () => {},
  // eslint-disable-next-line no-restricted-syntax -- 20 automatic reads shared by clocks and lifecycle events; only trusted input can renew attempts. Rejected/false results double the delay; every five attempts also doubles it; ceiling 15 minutes Hidden or 30-minute idle; no lifecycle or scroll renewal. Live recorder keepAlive is still capped at 20
  setTimeout = (fn, ms) => window.setTimeout(fn, ms), clearTimeout = id => window.clearTimeout(id),
}) {
  let timer = null, disposed = false, running = null, attempts = 0, failures = 0, requested = false;
  const asked = () => typeof intervalMs === 'function' ? intervalMs() : intervalMs;
  const delay = () => Math.min(MAX_BACKOFF_MS, (keepAlive() ? asked() : Math.max(MIN_POLL_MS, asked())) * 2 ** Math.max(failures, Math.floor(attempts / 5)));
  let nextReadAt = periodic ? now() + delay() : now();
  const stop = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const eligible = () => !disposed && attempts < MAX_POLL_ATTEMPTS && (presence.active() || keepAlive());
  const arm = () => {
    stop();
    // eslint-disable-next-line no-restricted-syntax -- 20 automatic reads shared by clocks and lifecycle events; only trusted input can renew attempts. Rejected/false results double the delay; every five attempts also doubles it; ceiling 15 minutes Hidden or 30-minute idle; no lifecycle or scroll renewal. Live recorder keepAlive is still capped at 20
    if (eligible()) { timer = setTimeout(() => { timer = null; return run(); }, Math.max(0, nextReadAt - now())); timer?.unref?.(); }
  };
  const run = (manual = false, beforeRead, event = false) => {
    if (!eligible()) return Promise.resolve();
    // Resume hooks only invalidate local state; all I/O belongs to poll.
    beforeRead?.();
    if (running) { if (event) requested = true; return running; }
    if (!manual && !(event && failures === 0 && attempts < 5) && now() < nextReadAt) { arm(); return Promise.resolve(); }
    stop(); attempts++;
    let result;
    try { result = shouldPoll() ? poll() : undefined; } catch { result = false; }
    running = Promise.resolve(result)
      .then(value => { failures = value === false ? failures + 1 : 0; return value; }, () => { failures++; return false; })
      .finally(() => { running = null; nextReadAt = now() + delay(); if (requested && failures === 0 && attempts < 5) nextReadAt = now(); const again = periodic || requested; requested = false; if (again) arm(); });
    return running;
  };
  const restartFromInput = callback => {
    attempts = 0; failures = 0; nextReadAt = now(); return run(false, callback, true);
  };
  const presence = watchPresence({ document, window, idleMs, now,
    onResume: () => run(false, onResume, true),
    onWake: () => restartFromInput(onWake),
    onInput: () => { if (attempts >= MAX_POLL_ATTEMPTS) restartFromInput(() => {}); } });
  const visibility = () => { if (document.visibilityState === 'hidden' && !keepAlive()) stop(); };
  const eventRead = () => run(false, undefined, true);
  // eslint-disable-next-line no-restricted-syntax -- Visibility callback will stop the poll timer when hidden; 0 HTTP reads in this listener.
  document.addEventListener('visibilitychange', visibility);
  const lifecycleRead = () => run(false, onResume, true);
  // eslint-disable-next-line no-restricted-syntax -- Lifecycle dispatches share a max of 20 poll attempts and failure backoff; hidden or 30-minute idle state stops reads, and events never replenish attempts.
  if (lifecycle) { window.addEventListener('online', lifecycleRead); window.addEventListener('focus', lifecycleRead); }
  if (periodic) arm();
  return {
    refresh: () => run(true), poll: eventRead,
    revalidate() { const pending = running; onResume(); return pending ? pending.then(() => run(true)) : run(true); },
    dispose() { disposed = true; stop(); presence.dispose(); document.removeEventListener?.('visibilitychange', visibility); window.removeEventListener?.('online', lifecycleRead); window.removeEventListener?.('focus', lifecycleRead); },
  };
}

// A bounded local repaint clock paired with a bounded network poll. Both
// clocks stop while hidden or idle; their work keeps separate budgets.
export function mountLocalClock({
  tick, read, intervalMs, window = globalThis, ...pollOptions
}) {
  const timer = mountLocalTicker({ tick, intervalMs, window, ...pollOptions });
  const network = mountVisibilityPoll({ poll: read, intervalMs, window, ...pollOptions });
  return { dispose() { timer.dispose(); network.dispose(); } };
}

// Local repaint clocks have their own bounded visible period. Returning to
// view repaints immediately without renewing any network poller's presence.
export function mountLocalTicker({ tick, intervalMs, document = globalThis.document, window = document?.defaultView || globalThis,
  maxTicks = Math.ceil(IDLE_CUTOFF_MS / intervalMs), idleMs = IDLE_CUTOFF_MS, now = () => Date.now(),
  // eslint-disable-next-line no-restricted-syntax -- ceil(30 minutes / intervalMs) local ticks per visible period, including the immediate return repaint. Local repaint only; a failed callback stops the clock without retry Hidden stops immediately; thirty minutes without local return/input or the tick cap stops repainting. Local resume never renews network presence.
  setInterval = (fn, ms) => window.setInterval(fn, ms), clearInterval = id => window.clearInterval(id) }) {
  let timer = null, ticks = 0, disposed = false, lastActivity = now();
  const active = () => document.visibilityState !== 'hidden' && now() - lastActivity < idleMs;
  const stop = () => { if (timer !== null) clearInterval(timer); timer = null; };
  const repaint = () => {
    if (disposed || !active() || ticks >= maxTicks) { stop(); return false; }
    ticks++;
    try { tick(); } catch { stop(); return false; }
    if (ticks >= maxTicks) stop();
    return ticks < maxTicks;
  };
  const start = (immediate = false) => {
    if (disposed || timer !== null || !active()) return;
    ticks = 0;
    if (immediate && !repaint()) return;
    // eslint-disable-next-line no-restricted-syntax -- ceil(30 minutes / intervalMs) local ticks per visible period, including the immediate return repaint. Local repaint only; a failed callback stops the clock without retry Hidden stops immediately; thirty minutes without local return/input or the tick cap stops repainting. Local resume never renews network presence.
    timer = setInterval(() => { if (timer !== null) repaint(); }, intervalMs);
    timer?.unref?.();
  };
  const resume = () => { lastActivity = now(); start(true); };
  const input = listenForHumanInput(document, resume);
  const returned = mountReadOnResume({ document, window, refresh: () => { stop(); resume(); } });
  const visibility = () => { if (document.visibilityState === 'hidden') stop(); };
  // eslint-disable-next-line no-restricted-syntax -- Visibility callback will stop the local ticker when hidden; 0 HTTP reads in this listener.
  document.addEventListener('visibilitychange', visibility);
  start();
  return { dispose() { disposed = true; stop(); input(); returned.dispose(); document.removeEventListener('visibilitychange', visibility); } };
}
