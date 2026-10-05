import { USAGE_SCHEMA, usageScreen, validUsageEvent } from './usage-contract.v1.js';

export function createUsageCapture({ partner, releaseSha, now = () => new Date(), send, enabled = () => true }) {
  return {
    async record(eventName, screen, ...extra) {
      if (extra.length || !enabled()) return false;
      const event = { event_name: eventName, screen, partner, release_sha: releaseSha, timestamp: now().toISOString() };
      if (!validUsageEvent(event)) return false;
      try { await send(event); return true; } catch { return false; }
    },
  };
}

export function emitUsage(root, eventName) {
  root.dispatchEvent(new root.defaultView.CustomEvent('doctorcre:usage', { detail: eventName }));
}

export function mountUsageCapture({ document: root, window: win, fetch: request = (...args) => win.fetch(...args), now }) {
  let capture = null, disposed = false, serverEnabled = false, localEnabled = true;
  const screen = usageScreen(win.location.pathname);
  const button = root.getElementById('usageCaptureToggle');
  try { localEnabled = win.localStorage.getItem('doctorcre:usage-capture') !== 'off'; } catch { localEnabled = false; }
  const enabled = () => !disposed && serverEnabled && localEnabled;
  const paint = () => {
    if (!button) return;
    button.setAttribute('aria-pressed', String(enabled()));
    button.title = enabled() ? 'Usage capture on' : 'Usage capture off';
    button.setAttribute('aria-label', button.title);
    button.textContent = enabled() ? '◉' : '○';
  };
  const setEnabled = value => {
    localEnabled = value === true;
    try { win.localStorage.setItem('doctorcre:usage-capture', localEnabled ? 'on' : 'off'); } catch { localEnabled = false; }
    paint();
  };
  const record = eventName => capture?.record(eventName, screen);
  const semantic = event => { if (typeof event.detail === 'string') void record(event.detail); };
  const primary = event => {
    const target = event.target.closest?.('.primary-action, .btn-primary, button.primary, .system-work-primary, [data-usage-primary], #homePrimaryAction, #dialogSubmit, #saveStage, [data-claim], [data-link], [data-undo]');
    if (target && !target.disabled && !(target.type === 'submit' && target.form)) void record('primary_action_used');
  };
  const submit = event => {
    if (event.target.matches('#searchForm, #docCommandForm')) return;
    if (event.target.querySelector('.primary-action, .btn-primary, button.primary, [data-usage-primary], #dialogSubmit, #saveStage')) void record('primary_action_used');
  };
  const shownErrors = new WeakSet();
  const observeErrors = () => {
    for (const node of root.querySelectorAll('[role="alert"], .error, .inline-error, .read-error, [data-state="failed"]')) {
      const visible = !node.hidden && !node.closest('[hidden], dialog:not([open])') && node.textContent.trim().length > 0;
      if (!visible) { shownErrors.delete(node); continue; }
      if (!shownErrors.has(node)) { shownErrors.add(node); void record('error_shown'); }
    }
  };
  const observer = new win.MutationObserver(observeErrors);
  const ready = (async () => {
    if (!screen) return;
    try {
      const [sessionResponse, releaseResponse] = await Promise.all([
        request('/api/v1/usage-signals/session', { credentials: 'same-origin', cache: 'no-store' }),
        request('/app-release', { cache: 'no-store' }),
      ]);
      if (!sessionResponse.ok || !releaseResponse.ok || disposed) return;
      const session = await sessionResponse.json(), release = await releaseResponse.json();
      if (disposed || session.schema !== USAGE_SCHEMA || !['joe', 'dell'].includes(session.partner) || !/^[a-f0-9]{40}$/.test(release.source_commit || '') || typeof session.csrf_token !== 'string') return;
      serverEnabled = session.enabled === true;
      capture = createUsageCapture({ partner: session.partner, releaseSha: release.source_commit, now, enabled,
        send: async event => {
          const response = await request('/api/v1/usage-signals', { method: 'POST', credentials: 'same-origin', keepalive: true,
            headers: { 'content-type': 'application/json', 'x-carr-csrf': session.csrf_token }, body: JSON.stringify(event) });
          if (!response.ok) throw new Error('Capture unavailable');
        },
      });
      paint();
      root.addEventListener('doctorcre:usage', semantic);
      root.addEventListener('click', primary, true);
      root.addEventListener('submit', submit, true);
      observer.observe(root.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'open', 'data-state'] });
      await record('screen_viewed'); observeErrors();
    } catch { serverEnabled = false; paint(); }
  })();
  if (button) button.onclick = () => setEnabled(!localEnabled);
  paint();
  return { ready, setEnabled, dispose() { disposed = true; observer.disconnect(); root.removeEventListener('doctorcre:usage', semantic); root.removeEventListener('click', primary, true); root.removeEventListener('submit', submit, true); } };
}
