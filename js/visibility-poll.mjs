// Network polling runs only for a person who is looking. Every read the app
// repeats on a clock goes to CARR, and CARR's database bills while anything
// keeps it awake: one forgotten tab polling all night costs a full day of
// compute. So a hidden tab makes no calls at all, and a visible tab with no
// input for IDLE_CUTOFF_MS pauses too. A return from either reads once at
// once, then the normal cadence resumes, so a person never waits on a clock.
import { mountReadOnResume } from "./read-on-resume.mjs";

export const IDLE_CUTOFF_MS = 30 * 60_000;
// No background read runs more often than once a minute; a person who wants
// fresher data presses refresh.
export const MIN_POLL_MS = 60_000;
export const MAX_POLL_ATTEMPTS = 20;
export const MAX_BACKOFF_MS = 15 * 60_000;
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel", "scroll"];

// active() says whether a network read may run now. onResume runs once per
// return to view (visibilitychange or a back-forward cache restore); returning
// to the tab counts as input. onWake runs once per first input after the idle
// cutoff in a tab that never left view, so it must only read: a page's
// return-from-hidden hook (closing private views) never runs on a wake.
// touch() records input from a caller that reads for itself, without either.
export function watchPresence({ document, window, onResume, onWake, onInput = () => {}, idleMs = IDLE_CUTOFF_MS, now = () => Date.now() }) {
  let lastInput = now();
  const hidden = () => document.visibilityState === "hidden";
  const idle = () => now() - lastInput >= idleMs;
  const input = () => {
    const waking = idle() && !hidden();
    lastInput = now();
    if (waking) onWake();
    else if (!hidden()) onInput();
  };
  const resume = mountReadOnResume({ document, window, refresh: () => { lastInput = now(); return onResume(); } });
  const options = { capture: true, passive: true };
  INPUT_EVENTS.forEach(type => document.addEventListener(type, input, options));
  return {
    active: () => !hidden() && !idle(),
    touch() { lastInput = now(); },
    dispose() { resume.dispose(); INPUT_EVENTS.forEach(type => document.removeEventListener?.(type, input, options)); },
  };
}

// One repeating network read. The next tick is armed when the previous poll
// settles, so a poll that returns its promise never overlaps itself; one that
// returns nothing keeps a fixed cadence. Going hidden clears the timer; a tick
// that finds the person idle does not poll and does not re-arm. keepAlive()
// is the one exception: while it is true the poll runs hidden or idle too.
// refresh() polls now and restarts the cadence from that read. intervalMs
// defaults to, and outside keepAlive is floored at, MIN_POLL_MS.
export function mountVisibilityPoll({
  poll, intervalMs = MIN_POLL_MS, keepAlive = () => false, idleMs, now,
  document = globalThis.document, window = globalThis,
  setTimeout = (fn, ms) => window.setTimeout(fn, ms), clearTimeout = id => window.clearTimeout(id),
}) {
  let timer = null;
  let generation = 0;
  let disposed = false;
  let attempts = 0;
  let failures = 0;
  const asked = () => (typeof intervalMs === "function" ? intervalMs() : intervalMs);
  // Call mode's keepAlive poll reads the local companion, not CARR.
  // Absorbed failures still back off after every five automatic attempts.
  const delay = () => Math.min(MAX_BACKOFF_MS, (keepAlive() ? asked() : Math.max(MIN_POLL_MS, asked())) * 2 ** Math.max(failures, Math.floor(attempts / 5)));
  const stop = () => { if (timer !== null) clearTimeout(timer); timer = null; generation += 1; };
  const arm = () => { if (attempts < MAX_POLL_ATTEMPTS && (presence.active() || keepAlive())) timer = setTimeout(tick, delay()); };
  const refresh = () => {
    stop();
    if (disposed || attempts >= MAX_POLL_ATTEMPTS) return Promise.resolve();
    const mine = generation;
    attempts++;
    return Promise.resolve().then(() => poll()).then(value => { failures = value === false ? failures + 1 : 0; }, () => { failures++; }).finally(() => { if (mine === generation && !disposed) arm(); });
  };
  const tick = () => { timer = null; if (presence.active() || keepAlive()) refresh(); };
  const presence = watchPresence({ document, window, idleMs, now, onResume: () => { attempts = 0; failures = 0; return refresh(); }, onWake: () => { attempts = 0; failures = 0; return refresh(); }, onInput: () => { if (attempts >= MAX_POLL_ATTEMPTS) { attempts = 0; failures = 0; refresh(); } } });
  const visibility = () => { if (document.visibilityState === "hidden" && !keepAlive()) stop(); };
  document.addEventListener("visibilitychange", visibility);
  if (presence.active() || keepAlive()) arm();
  return {
    refresh() { attempts = 0; failures = 0; return refresh(); },
    dispose() { disposed = true; stop(); presence.dispose(); document.removeEventListener?.("visibilitychange", visibility); },
  };
}

// A bounded local repaint clock paired with a bounded network poll. Both
// clocks stop while hidden or idle; their work keeps separate budgets.
export function mountLocalClock({
  tick, read, intervalMs, window = globalThis,
  setInterval = (fn, ms) => window.setInterval(fn, ms), clearInterval = id => window.clearInterval(id), ...pollOptions
}) {
  const timer = mountLocalTicker({ tick, intervalMs, window, setInterval, clearInterval, ...pollOptions });
  const network = mountVisibilityPoll({ poll: read, intervalMs, window, ...pollOptions });
  return { dispose() { timer.dispose(); network.dispose(); } };
}

// Local repaint clocks stop after thirty minutes of ticks as well as on
// absence. They never retry failed callbacks or perform network reads.
export function mountLocalTicker({ tick, intervalMs, document = globalThis.document, window = document?.defaultView || globalThis,
  maxTicks = Math.ceil(IDLE_CUTOFF_MS / intervalMs), idleMs, now,
  setInterval = (fn, ms) => window.setInterval(fn, ms), clearInterval = id => window.clearInterval(id) }) {
  let timer = null, ticks = 0, disposed = false;
  const stop = () => { if (timer !== null) clearInterval(timer); timer = null; };
  const start = () => {
    if (disposed || timer !== null || !presence.active()) return;
    ticks = 0;
    timer = setInterval(() => {
      if (disposed || timer === null || !presence.active() || ticks >= maxTicks) { stop(); return; }
      ticks++;
      try { tick(); } catch { stop(); }
      if (ticks >= maxTicks) stop();
    }, intervalMs);
    timer?.unref?.();
  };
  const presence = watchPresence({ document, window, idleMs, now, onResume: start, onWake: start, onInput: () => { if (ticks >= maxTicks) start(); } });
  const visibility = () => { if (document.visibilityState === 'hidden') stop(); };
  document.addEventListener('visibilitychange', visibility);
  start();
  return { dispose() { disposed = true; stop(); presence.dispose(); document.removeEventListener('visibilitychange', visibility); } };
}
