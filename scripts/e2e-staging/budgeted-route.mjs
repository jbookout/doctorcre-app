// The only path a live browser context's traffic may take. Every request is
// refused locally, or reserved against the RunBudget and then sent by this
// process, never following a redirect, with the response body metered as it
// streams. WebSockets are closed
// before connecting. Writes are refused unless the profile funds mutations and
// the write names a synthetic fixture record of this run.
import { stagingRequestAllowed, hideCredentialPixels } from './engine.mjs';
import { readMetered } from './session.mjs';

// Read verbs the app issues over POST /mcp. A POST that is not one of these
// exact tools/call reads is treated as a write; an unknown verb is never
// assumed to be safe. This is a client-side boundary only: what a read verb
// does on the server (including any server-side model use) is not visible here.
export const READ_VERBS = new Set([
  'capture-queue', 'correspondence-readiness', 'current-work-item', 'current-work-requests', 'deal-room-board',
  'engineering-passport', 'find', 'find-and-catch-up', 'get-call-context', 'get-deal-room', 'get-incident',
  'governance-queue', 'incident-board', 'lead-board', 'list-doc-conversations', 'list-doc-suggestions',
  'list-industry-events', 'list-my-codex-sessions', 'list-progress-boards', 'loop-board', 'loop-headers',
  'morning-brief', 'notification-feed', 'read-assurance-health', 'read-correspondence-thread', 'read-dispatch-history',
  'read-doc-activity', 'read-doc-conversation', 'read-doc-outcome-cards', 'read-invoice-tracker', 'read-loop',
  'read-notification-preferences', 'read-portfolio', 'read-progress-board', 'read-resource-dashboard', 'read-room',
  'read-room-queue', 'read-session-identity', 'schedule-board', 'today-triage', 'unfinished-work', 'work-request-card',
]);

// Headers the transport owns, or that only make sense hop by hop.
const DROPPED_REQUEST = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'expect', 'te', 'trailer', 'proxy-connection']);
// fetch() decodes the body, so its encoding and length no longer describe it.
const DROPPED_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie']);

function postBody(request) {
  try { return request.postDataJSON(); } catch { return undefined; }
}

function isRead(request) {
  if (['GET', 'HEAD'].includes(request.method())) return true;
  if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/mcp') return false;
  const body = postBody(request);
  return body?.method === 'tools/call' && READ_VERBS.has(body?.params?.name);
}

// A write is fixture-tagged when its JSON body names one of the run's
// synthetic fixture records anywhere in its arguments.
function namesFixture(value, fixtureIds, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === 'string') return fixtureIds.has(value);
  if (typeof value !== 'object') return false;
  return Object.values(value).some(item => namesFixture(item, fixtureIds, depth + 1));
}

// Sends one request from this process. Redirects are never followed here, the
// declared length and every streamed chunk are metered against the
// per-response cap and the run's ingress total, and the bytes that arrived are
// charged even when the response is refused part-way.
export async function streamingFetch(context, request, budget, signal) {
  const url = request.url();
  const headers = {};
  for (const [name, value] of Object.entries(await request.allHeaders())) if (!name.startsWith(':') && !DROPPED_REQUEST.has(name)) headers[name] = value;
  if (!headers.cookie) {
    const cookies = await context.cookies(url);
    if (cookies.length) headers.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }
  const method = request.method();
  const response = await fetch(url, {
    method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : request.postDataBuffer() ?? undefined,
    redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(budget.timeoutMs())]),
  });
  const body = await readMetered(response, budget.ingressMeter());
  // Chromium follows a fulfilled redirect without routing the next hop, so
  // that hop would skip both the allowlist and the budget. A 3xx therefore
  // reaches the page without its Location: the redirect is a dead end.
  const redirect = response.status >= 300 && response.status < 400;
  const out = {};
  for (const [name, value] of response.headers) if (!DROPPED_RESPONSE.has(name) && !(redirect && name === 'location')) out[name] = value;
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies.join('\n');
  return { status: response.status, headers: out, body };
}

export async function installBudgetedRoute(context, budget, { allowed = stagingRequestAllowed, fixtureIds = budget.fixtureIds, transport = streamingFetch } = {}) {
  await context.routeWebSocket(() => true, socket => socket.close());
  await context.route(() => true, async route => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { return route.abort('blockedbyclient').catch(() => {}); }
    if (!allowed(url)) return route.abort('blockedbyclient').catch(() => {});
    let kind = 'http';
    if (!isRead(request)) {
      if (!budget.profile.mutation) {
        await budget.reserve('mutation').catch(() => {});
        return route.abort('blockedbyclient').catch(() => {});
      }
      if (!namesFixture(postBody(request), fixtureIds)) {
        await budget.stop('mutation-untagged').catch(() => {});
        return route.abort('blockedbyclient').catch(() => {});
      }
      kind = 'mutation';
    }
    let response;
    try { response = await budget.dispatch(kind, signal => transport(context, request, budget, signal)); }
    catch { return route.abort('failed').catch(() => {}); }
    await route.fulfill(response).catch(() => {});
  });
  await context.addInitScript(hideCredentialPixels);
}

