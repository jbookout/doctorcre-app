// Network polling runs only for a person who is looking. Every read the app
// repeats on a clock goes to CARR, and CARR's database bills while anything
// keeps it awake: one forgotten tab polling all night costs a full day of
// compute. So a hidden tab makes no calls at all, and a visible tab with no
// input for IDLE_CUTOFF_MS pauses too. Returning requests a refresh through
// the shared minimum gap and request limits.
import { pollSafety } from "./poll-safety.mjs";
import { mountReadOnResume } from "./read-on-resume.mjs";

export const IDLE_CUTOFF_MS = 30 * 60_000;
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel", "scroll"];

// active() says whether a network read may run now. onResume runs once per
// return to view (visibilitychange or a back-forward cache restore); returning
// to the tab counts as input. onWake runs once per first input after the idle
// cutoff in a tab that never left view, so it must only read: a page's
// return-from-hidden hook (closing private views) never runs on a wake.
// touch() records input from a caller that reads for itself, without either.
export function watchPresence({ document, window, onResume, onWake, idleMs = IDLE_CUTOFF_MS, now = () => Date.now() }) {
  let lastInput = now();
  const hidden = () => document.visibilityState === "hidden";
  const idle = () => now() - lastInput >= idleMs;
  const input = () => {
    const waking = idle() && !hidden();
    lastInput = now();
    if (waking) onWake();
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
// returns nothing keeps a bounded cadence. Going hidden clears the timer; a tick
// that finds the person idle does not poll and does not re-arm. keepAlive()
// is the presence exception: its poll still obeys shared request limits.
// refresh() polls now and restarts the cadence from that read.
export function mountVisibilityPoll({
  poll, intervalMs, keepAlive = () => false, idleMs, now,
  document = globalThis.document, window = globalThis,
  setTimeout = (fn, ms) => window.setTimeout(fn, ms), clearTimeout = id => window.clearTimeout(id),
}) {
  const safety = pollSafety(window, { document, now });
  const clockNow = now || (() => Date.now());
  let timer = null;
  let generation = 0;
  let initialized = false;
  let disposed = false;
  const delay = () => (typeof intervalMs === "function" ? intervalMs() : intervalMs);
  const stop = () => { if (timer !== null) clearTimeout(timer); timer = null; generation += 1; };
  const arm = () => {
    if (!safety.state().paused) timer = setTimeout(tick, Math.max(delay(), safety.state().nextAt - clockNow()));
  };
  const run = (manual = false, initial = false) => {
    stop();
    if (disposed) return Promise.resolve();
    const mine = generation;
    return safety.run(() => {
      if (disposed || (!presence.active() && !keepAlive())) return;
      initialized = true; return poll();
    }, { intervalMs: delay(), keepAlive: keepAlive(), manual, initial }).catch(() => {
      // The page's poll renders its own failure; the cadence carries on.
    }).finally(() => { if (mine === generation && !disposed) arm(); });
  };
  const refresh = event => run(Boolean(event?.isTrusted || window.navigator?.userActivation?.isActive), !initialized);
  const tick = () => { timer = null; if (presence.active() || keepAlive()) run(); };
  const presence = watchPresence({ document, window, idleMs, now, onResume: () => run(), onWake: () => run() });
  const visibility = () => { if (document.visibilityState === "hidden" && !keepAlive()) stop(); };
  document.addEventListener("visibilitychange", visibility);
  const unsubscribe = safety.subscribe(() => { stop(); if (presence.active() || keepAlive()) arm(); });
  if (presence.active() || keepAlive()) arm();
  return {
    refresh,
    dispose() { disposed = true; unsubscribe(); stop(); presence.dispose(); document.removeEventListener?.("visibilitychange", visibility); },
  };
}

// A local clock with one network read in it. tick() is local work, such as a
// repaint against the wall clock, and keeps its fixed cadence hidden or idle,
// because it costs CARR nothing. read() goes to CARR, so it runs through
// mountVisibilityPoll and sleeps while the person is away.
export function mountLocalClock({
  tick, read, intervalMs, window = globalThis,
  setInterval = (fn, ms) => window.setInterval(fn, ms), clearInterval = id => window.clearInterval(id), ...pollOptions
}) {
  const timer = setInterval(tick, intervalMs);
  const network = mountVisibilityPoll({ poll: read, intervalMs, window, ...pollOptions });
  return { dispose() { clearInterval(timer); network.dispose(); } };
}
