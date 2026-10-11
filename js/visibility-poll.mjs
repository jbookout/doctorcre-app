// Network polling runs only for a person who is looking. Every read the app
// repeats on a clock goes to CARR, and CARR's database bills while anything
// keeps it awake: one forgotten tab polling all night costs a full day of
// compute. So a hidden tab makes no calls at all, and a visible tab with no
// input for IDLE_CUTOFF_MS pauses too. A return from either reads once at
// once, then the normal cadence resumes, so a person never waits on a clock.
import { mountReadOnResume } from "./read-on-resume.mjs";

export const IDLE_CUTOFF_MS = 30 * 60_000;
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel", "scroll"];

// active() says whether a network read may run now. onResume runs once per
// return to view (visibilitychange or a back-forward cache restore) and once
// per first input after the idle cutoff; returning to the tab counts as input.
export function watchPresence({ document, window, onResume, idleMs = IDLE_CUTOFF_MS, now = () => Date.now() }) {
  let lastInput = now();
  const hidden = () => document.visibilityState === "hidden";
  const idle = () => now() - lastInput >= idleMs;
  const input = () => {
    const returning = idle() && !hidden();
    lastInput = now();
    if (returning) onResume();
  };
  const resume = mountReadOnResume({ document, window, refresh: () => { lastInput = now(); return onResume(); } });
  const options = { capture: true, passive: true };
  INPUT_EVENTS.forEach(type => document.addEventListener(type, input, options));
  return {
    active: () => !hidden() && !idle(),
    dispose() { resume.dispose(); INPUT_EVENTS.forEach(type => document.removeEventListener?.(type, input, options)); },
  };
}

// One repeating network read. The next tick is armed when the previous poll
// settles, so a poll that returns its promise never overlaps itself; one that
// returns nothing keeps a fixed cadence. Going hidden clears the timer; a tick
// that finds the person idle does not poll and does not re-arm. keepAlive()
// is the one exception: while it is true the poll runs hidden or idle too.
// refresh() polls now and restarts the cadence from that read.
export function mountVisibilityPoll({
  poll, intervalMs, keepAlive = () => false, idleMs, now,
  document = globalThis.document, window = globalThis,
  setTimeout = (fn, ms) => window.setTimeout(fn, ms), clearTimeout = id => window.clearTimeout(id),
}) {
  let timer = null;
  let generation = 0;
  let disposed = false;
  const delay = () => (typeof intervalMs === "function" ? intervalMs() : intervalMs);
  const stop = () => { if (timer !== null) clearTimeout(timer); timer = null; generation += 1; };
  const arm = () => { timer = setTimeout(tick, delay()); };
  const refresh = () => {
    stop();
    if (disposed) return Promise.resolve();
    const mine = generation;
    return Promise.resolve().then(() => poll()).catch(() => {
      // The page's poll renders its own failure; the cadence carries on.
    }).finally(() => { if (mine === generation && !disposed) arm(); });
  };
  const tick = () => { timer = null; if (presence.active() || keepAlive()) refresh(); };
  const presence = watchPresence({ document, window, idleMs, now, onResume: refresh });
  const visibility = () => { if (document.visibilityState === "hidden" && !keepAlive()) stop(); };
  document.addEventListener("visibilitychange", visibility);
  if (presence.active() || keepAlive()) arm();
  return {
    refresh,
    dispose() { disposed = true; stop(); presence.dispose(); document.removeEventListener?.("visibilitychange", visibility); },
  };
}
