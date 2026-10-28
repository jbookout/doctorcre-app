import { pollSafety } from '../js/poll-safety.mjs';

export function installPollFixtureClock(window) {
  let offset = 0, serial = 0;
  const timers = new Map();
  const epoch = Date.now();
  const now = () => epoch + offset;
  const NativeDate = window.Date;
  window.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now()])); }
    static now() { return now(); }
  };
  let activeUntil = 0;
  const activation = { get isActive() { return now() < activeUntil; } };
  Object.defineProperty(window.navigator, 'locks', { configurable: true, value: { request: (_name, _options, callback) => callback({}) } });
  Object.defineProperty(window.navigator, 'userActivation', { configurable: true, value: activation });
  window.setTimeout = (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: now() + ms }); return id; };
  window.clearTimeout = id => timers.delete(id);
  const safety = pollSafety(window, { document: window.document, now });
  const advance = ms => {
    offset += ms;
    const due = [...timers].filter(([, job]) => job.at <= now()).sort((a, b) => a[1].at - b[1].at);
    for (const [id, job] of due) if (timers.delete(id)) job.fn();
  };
  const person = operation => {
    offset += 5_001; activeUntil = now() + 5_000;
    return operation();
  };
  for (const type of ['click', 'submit']) window.document.addEventListener(type, () => {
    offset += 5_001; activeUntil = now() + 5_000;
  }, true);
  for (const target of [window, window.document]) {
    const dispatch = target.dispatchEvent.bind(target);
    target.dispatchEvent = event => {
      if (event.type === 'online' || event.type === 'pageshow' || (event.type === 'visibilitychange' && window.document.visibilityState !== 'hidden')) advance(Math.max(5_001, safety.state().nextAt - now() + 1));
      return dispatch(event);
    };
  }
  const controls = ui => {
    for (const key of ['refresh', 'open']) { const operation = ui[key]; ui[key] = (...args) => person(() => operation(...args)); }
    return ui;
  };
  return { advance, person, controls };
}
