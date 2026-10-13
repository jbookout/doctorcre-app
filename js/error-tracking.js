import contract from '../contracts/runtime-errors.v1.json' with { type: 'json' };

const TYPES = new Set(contract.types);
const ROUTES = new Set(contract.route_segments);
const SHA = /^[a-f0-9]{40}$/;
// One fingerprint is admitted at most once per window_ms / count: the fastest
// repeat CARR still needs to see a sustained spike, and no faster.
export const REPEAT_MS = contract.spike.window_ms / contract.spike.count;
export const BROWSER_LIMIT = 10;
export const EDGE_LIMIT = 60;
export const REPORT_BYTES = 12000;

// The pinned producer's scrub rules, applied before anything leaves this app.
// Only allowlisted types and message templates, static route segments, stack
// line/column positions and the release SHA survive.
export function scrubError(input, fallbackType = 'Error') {
  const type = TYPES.has(input?.type) ? input.type : fallbackType;
  const text = typeof input?.message === 'string' ? input.message.slice(0, 1000) : '';
  const message = /^Cannot read properties of /.test(text) ? 'Cannot read properties of [redacted]'
    : /^\S+ is not defined/.test(text) ? '[redacted] is not defined'
    : /^(Failed to fetch|Load failed|NetworkError|Script error\.?)$/.test(text) ? text
    : type === 'HTTP5xx' ? 'HTTP 5xx response' : '[redacted]';
  const route = String(typeof input?.route === 'string' ? input.route : '/').split(/[?#]/)[0].split('/').slice(0, 8)
    .map(part => !part || ROUTES.has(part) ? part : ':value').join('/');
  const stack = String(typeof input?.stack === 'string' ? input.stack : '').slice(0, 8000).split('\n').slice(0, 20)
    .flatMap(line => {
      if (!/^\s*(?:at\s|asset:)|^[^\s:]*@(?:https?:\/\/|\/)/.test(line)) return [];
      const match = line.match(/:(\d{1,7}):(\d{1,7})\)?\s*$/);
      return match ? [`asset:${match[1]}:${match[2]}`] : [];
    }).join('\n');
  return { type, message, stack, route: route.startsWith('/') ? route : '/:value',
    release_sha: SHA.test(input?.release_sha || '') ? input.release_sha : null };
}

/** Admits one scrubbed report per fingerprint per REPEAT_MS, and `limit` per window overall. */
export function createErrorGate({ limit, now = Date.now, repeatMs = REPEAT_MS, windowMs = 60_000, maxKeys = 256 }) {
  const seen = new Map();
  let windowStart = -Infinity, admitted = 0;
  return report => {
    const at = now();
    const key = JSON.stringify([report.type, report.message, report.stack, report.route]);
    if (at - windowStart >= windowMs) { windowStart = at; admitted = 0; }
    if (at - (seen.get(key) ?? -Infinity) < repeatMs || admitted >= limit) return false;
    admitted++;
    seen.delete(key);
    seen.set(key, at);
    if (seen.size > maxKeys) seen.delete(seen.keys().next().value);
    return true;
  };
}

export function installErrorTracking(host, releaseSha, gate = createErrorGate({ limit: BROWSER_LIMIT })) {
  let reporting = false;
  // Reading the error, scrubbing and sending all stay inside the guard: a
  // hostile reason or a failed send never breaks the page's own handlers.
  const report = (read, fallbackType) => {
    if (reporting) return;
    reporting = true;
    try {
      let evidence;
      try {
        const error = read();
        evidence = scrubError({ type: error?.name, message: error?.message, stack: error?.stack,
          route: host.location.pathname, release_sha: releaseSha }, fallbackType);
      } catch { evidence = scrubError({ route: host.location.pathname, release_sha: releaseSha }, fallbackType); }
      if (!gate(evidence)) return;
      Promise.resolve(host.fetch(contract.browser_endpoint, { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(evidence), keepalive: true })).catch(() => {});
    } catch { /* Diagnostics are best effort. */ } finally { reporting = false; }
  };
  const onError = event => report(() => event.error || { name: 'Error', message: event.message,
    stack: `asset:${Number(event.lineno) || 0}:${Number(event.colno) || 0}` }, 'Error');
  const onRejection = event => report(() => event.reason, 'UnhandledRejection');
  host.addEventListener('error', onError);
  host.addEventListener('unhandledrejection', onRejection);
  return () => {
    host.removeEventListener('error', onError);
    host.removeEventListener('unhandledrejection', onRejection);
  };
}
