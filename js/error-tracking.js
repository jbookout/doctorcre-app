import contract from '../contracts/runtime-errors.v1.json' with { type: 'json' };
const TYPES = new Set(contract.types);
const ROUTES = new Set(contract.route_segments);

export function browserError(error, route, releaseSha) {
  const text = typeof error?.message === 'string' ? error.message : '';
  const message = /^Cannot read properties of /.test(text) ? 'Cannot read properties of [redacted]'
    : /^\S+ is not defined/.test(text) ? '[redacted] is not defined'
    : /^(Failed to fetch|Load failed|NetworkError|Script error\.?)$/.test(text) ? text : '[redacted]';
  return { type: TYPES.has(error?.name) ? error.name : 'UnhandledRejection', message,
    stack: String(error?.stack || '').slice(0, 8000).split('\n').slice(0, 20).flatMap(line => {
      if (!/^\s*(?:at\s|asset:)|^[^\s:]*@(?:https?:\/\/|\/)/.test(line)) return [];
      const match = line.match(/:(\d{1,7}):(\d{1,7})\)?\s*$/); return match ? [`asset:${match[1]}:${match[2]}`] : [];
    }).join('\n'),
    route: String(route || '/').split(/[?#]/)[0].split('/').slice(0, 8).map(part => !part || ROUTES.has(part) ? part : ':value').join('/'),
    release_sha: /^[a-f0-9]{40}$/.test(releaseSha || '') ? releaseSha : null };
}

export function reportBrowserError(host, releaseSha, error) {
  const body = JSON.stringify(browserError(error, host.location.pathname, releaseSha));
  try {
    return Promise.resolve(host.fetch(contract.browser_endpoint, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body, keepalive: true })).catch(() => {});
  } catch { return Promise.resolve(); }
}

export function installErrorTracking(host, releaseSha) {
  const priorError = host.onerror;
  const priorRejection = host.onunhandledrejection;
  const report = error => { void reportBrowserError(host, releaseSha, error); };
  host.onerror = function(message, source, line, column, error) {
    report(error || { name: 'Error', message, stack: `asset:${Number(line) || 0}:${Number(column) || 0}` });
    return priorError?.apply(this, arguments) ?? false;
  };
  host.onunhandledrejection = function(event) { report(event.reason); return priorRejection?.call(this, event); };
  return () => { host.onerror = priorError; host.onunhandledrejection = priorRejection; };
}

export function createErrorBoundary(React, report) {
  return class ErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { failed: false }; }
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(error) { report(error); }
    render() { return this.state.failed ? this.props.fallback : this.props.children; }
  };
}
