import carrSchema from "../contracts/carr-interface.v1/schema.json" with { type: "json" };
import carrVersion from "../contracts/carr-interface.v1/version.json" with { type: "json" };
import { routeContract, routeKey, actionLinkRoute, isRetiredPage } from "../js/routes.js";
import { isEngineDealDetail } from '../js/local-deals-model.js';

const APP_ROUTES = new Map(Object.entries(routeContract.routes));
const REDIRECTS = new Map(Object.entries(routeContract.redirects || {}));
const PROXY_EXACT = new Set([
  "/mcp", "/pipeline/changes", "/api/call-context", "/api/post-call", "/api/system-work/session",
]);
const PROXY_PREFIXES = ["/auth/", "/api/v1/", "/api/tours/", "/api/post-call/"];
const RETIRED_API = /^\/api\/v1\/(atlas-graph|deal-deliverables|work-inventory)(?:\/|$)/;
const RETIRED_MCP_TOOLS = new Set([
  "engineering-passport", "read-portfolio", "work-request-card", "unfinished-work",
  "current-work-item", "current-work-requests", "decline-work-request", "supersede-work-request",
  "set-work-shape-disposition", "report-problem", "review-and-triage", "answer-work-request-for-joe",
  "complete-work-request", "append-work-request-scope", "propose-ready-plan", "accept-ready-plan",
  "accept-ready-plan-amendment", "propose-outcome-feedback", "accept-outcome-feedback",
  "incident-board", "get-incident", "link-incident-work-request", "triage-incident",
  "read-resource-dashboard", "governance-queue", "schedule-board", "read-session-identity",
  "list-my-codex-sessions", "read-dispatch-history", "record-dispatch-link", "acknowledge-dispatch",
  "read-room-queue", "read-room", "read-room-latest", "add-room-turn",
  "list-progress-boards", "read-progress-board", "work-queue", "answer-board-question",
  "approve-retrieval-proposals", "confirm-slice-completions", "cancel-capability-session",
  "cancel-workflow-cutover-plan", "advance-workflow-cutover-stage", "close-investigation",
  "loop-board", "read-loop", "loop-headers", "add-loop", "update-loop", "close-loop",
  "list-industry-events", "add-industry-event", "update-industry-event", "read-doc-activity", "read-doc-outcome-cards",
  "list-feature-switches", "list-doc-suggestions", "decide-doc-suggestion", "propose-doc-correction",
  "submit-doc-request", "morning-brief-queue", "morning-assurance-queue",
]);
const STATIC_EXACT = new Map([
  ["/artifact-manifest.json", "/artifact-manifest.json"],
  ["/manifest.webmanifest", "/manifest.webmanifest"],
  ["/sw.js", "/public-shell/sw.js"],
  ["/offline.html", "/public-shell/offline.html"],
  ["/favicon.ico", "/public-shell/icons/dealroom.svg"],
]);
const STATIC_PREFIXES = ["/css/", "/data/", "/js/", "/public-shell/", "/tours/"];
// Status stays reachable during a sign-in outage.
const UNGATED_PAGES = new Set(["/status"]);
// Each slice chooses an admitted CARR page gate through its route fragment.
// Authentication and authorization remain entirely in the producer.
const GATE_PATHS = new Map(Object.entries(routeContract.gatePaths));
const WORKSPACE_GATES = new Set([
  '/business', '/clients', '/vendors',
  '/notifications', '/conversations',
]);
const PARTNER_HEADERS = ['accept', 'content-type', 'content-length', 'origin',
  'sec-fetch-site', 'x-carr-csrf', 'x-correlation-id', 'user-agent'];
const PARTNER_SESSION_COOKIE = '__Host-doctorcre_session';
const PARTNER_OAUTH_STATE_COOKIE = '__Host-doctorcre_oauth_state';
const ENGINE_SIGN_IN_COOKIES = [PARTNER_SESSION_COOKIE, PARTNER_OAUTH_STATE_COOKIE];
const CARR_SIGN_IN_COOKIES = ['__Host-dealroom_session', '__Host-dealroom_oauth'];

function gateRequestFor(request, pathname) {
  const gatePath = GATE_PATHS.get(routeKey(actionLinkRoute(pathname)));
  if (!gatePath || gatePath === pathname) return request;
  const url = new URL(request.url);
  url.pathname = gatePath;
  url.search = "";
  return new Request(url, request);
}

function restoreOriginalReturnTo(response, request) {
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || !location) return response;
  const originalUrl = new URL(request.url);
  const redirectUrl = new URL(location, originalUrl);
  if (redirectUrl.origin !== originalUrl.origin || redirectUrl.pathname !== "/auth/login") return response;
  redirectUrl.searchParams.set("return_to", originalUrl.pathname + originalUrl.search);
  const headers = new Headers(response.headers);
  headers.set("location", redirectUrl.toString());
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function unavailable(documentRequest) {
  if (!documentRequest) return json({ error: "carr_unavailable" }, 503);
  return new Response("<!doctype html><title>DoctorCRE unavailable</title><h1>DoctorCRE is temporarily unavailable</h1><p>No cached business data is being shown.</p>", {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const engineSignIn = env => env?.PARTNER_SIGN_IN === 'engine';
const homeOnEngine = env => env?.APP_ENV === 'production' || env?.APP_ENV === 'staging' || engineSignIn(env);

function noStore(response) {
  const copy = new Response(response.body, response);
  copy.headers.set('cache-control', 'no-store');
  return copy;
}

function requestCookies(request) {
  const header = request.headers.get('cookie');
  return header ? header.split(';').map(cookie => cookie.trim()) : [];
}

function clearInactiveSignInCookies(request, response, env) {
  const cookies = requestCookies(request);
  const inactive = engineSignIn(env) ? CARR_SIGN_IN_COOKIES : ENGINE_SIGN_IN_COOKIES;
  const expired = inactive.filter(name => cookies.some(cookie => cookie.startsWith(`${name}=`)));
  if (!expired.length) return response;

  const result = noStore(response);
  for (const name of expired)
    result.headers.append('set-cookie', `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
  return result;
}

async function engineFetch(request, env) {
  if (!engineSignIn(env)) return env.ENGINE.fetch(request);
  const headers = new Headers();
  for (const key of PARTNER_HEADERS) {
    const value = request.headers.get(key);
    if (value !== null) headers.set(key, value);
  }
  const path = new URL(request.url).pathname;
  const googleCallback = request.method === 'GET' && path === '/auth/callback/google';
  // Better Auth checks the browser's OAuth state on the Google return.
  const cookies = requestCookies(request)
    .filter(cookie => cookie.startsWith(`${PARTNER_SESSION_COOKIE}=`) ||
      (googleCallback && cookie.startsWith(`${PARTNER_OAUTH_STATE_COOKIE}=`)));
  if (cookies.length) headers.set('cookie', cookies.join('; '));
  if ((request.method === 'GET' || request.method === 'HEAD') && path === '/api/engine/find' &&
      request.headers.get('x-doctorcre-search') === 'search.v1')
    headers.set('x-doctorcre-search', 'search.v1');
  return noStore(await env.PARTNER_APP.fetch(new Request(request, { headers, redirect: 'manual' })));
}

function shellMessage(request, status, { title, heading, action, style }) {
  return secure(new Response(request.method === 'HEAD' ? null : `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script src="/js/theme-boot.js"></script><link rel="stylesheet" href="/public-shell/shell.css"><title>${title}</title></head>
<body class="${style}"><main><h1>${heading}</h1>${action}</main></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }),
  new URL(request.url).pathname);
}

function signInPage(request, status = 503) {
  return shellMessage(request, status, status === 401 ? {
    title: 'Google sign-in',
    heading: 'We couldn’t complete Google sign-in',
    action: '<a href="/auth/login">Try again</a>',
    style: 'shell-refusal',
  } : {
    title: 'DoctorCRE unavailable',
    heading: 'DoctorCRE is temporarily unavailable',
    action: '<p>Try again in a moment.</p>',
    style: 'shell-offline',
  });
}

function partnerLoginRedirect(url) {
  const login = new URL('/auth/login', url);
  login.searchParams.set('return_to', url.pathname + url.search);
  return noStore(Response.redirect(login, 302));
}

async function authResponse(request, env, documentRequest) {
  try {
    const response = await engineFetch(request, env);
    if (response.status === 401 && documentRequest && new URL(request.url).pathname === '/auth/callback/google' &&
        request.headers.get('accept')?.includes('text/html')) {
      void response.body?.cancel().catch(() => {});
      return copySessionCookies(response, signInPage(request, 401));
    }
    if (response.status < 500 || (!documentRequest && response.status === 503)) return response;
    return copySessionCookies(response, documentRequest ? signInPage(request) : json({ error: 'sign_in_unavailable' }, 503));
  } catch {
    return documentRequest ? signInPage(request) : json({ error: 'sign_in_unavailable' }, 503);
  }
}

async function pageGate(request, env, gateRequest) {
  if (!engineSignIn(env)) {
    const gate = await carrResponse(gateRequest, env, true);
    return gateRequest === request ? gate : restoreOriginalReturnTo(gate, request);
  }
  if (env.WORKSPACE_COMMAND_CENTER_READ_ENABLED !== 'true' && WORKSPACE_GATES.has(new URL(gateRequest.url).pathname))
    return new Response(null, { status: 404, headers: JSON_HEADERS });
  const url = new URL(request.url);
  const response = await authResponse(new Request(new URL('/auth/session', url), { headers: request.headers }), env, false);
  void response.body?.cancel().catch(() => {});
  if (response.status === 200) return new Response(null, { headers: response.headers });
  if (response.status !== 401) return signInPage(request);
  return partnerLoginRedirect(url);
}

function gatedResponse(gate, response, env) {
  const result = copySessionCookies(gate, response);
  return engineSignIn(env) ? noStore(result) : result;
}

function secure(response, path) {
  const headers = new Headers(response.headers);
  const capture = path === "/tours/day.html" || path === "/calls" || path === "/calls.html";
  const tourEditor = path === '/tours/route-editor.html';
  headers.set("content-security-policy", [
    "default-src 'self'", "base-uri 'none'", "object-src 'none'", `frame-ancestors ${tourEditor ? "'self'" : "'none'"}`,
    "form-action 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:4682", "worker-src 'self'",
    ...(capture ? ["media-src 'self' blob:"] : []),
  ].join("; "));
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", tourEditor ? "SAMEORIGIN" : "DENY");
  headers.set("referrer-policy", "same-origin");
  headers.set("permissions-policy", `camera=(), geolocation=(), microphone=${capture ? "(self)" : "()"}, payment=(), usb=()`);
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function assetPath(pathname) {
  if (STATIC_EXACT.has(pathname)) return STATIC_EXACT.get(pathname);
  if (pathname.startsWith("/icons/")) return `/public-shell${pathname}`;
  return STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ? pathname : null;
}

async function pageSwitches(env) {
  const [dealsFromEngine, dealSavesFromEngine, clientsVendorsFromEngine, dealToursFromEngine] = await Promise.all([
    switchedOn(env, DEALS), switchedOn(env, NEXT_DEAL_SAVES), switchedOn(env, CLIENTS_VENDORS), switchedOn(env, DEAL_TOURS),
  ]);
  return { homeToday: homeOnEngine(env), dealsFromEngine, dealSavesFromEngine, clientsVendorsFromEngine, dealToursFromEngine };
}

async function assetResponse(request, env, path, switches) {
  if (!env?.ASSETS?.fetch) return json({ error: "app_assets_unavailable" }, 503);
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const response = await env.ASSETS.fetch(new Request(url, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: { accept: request.headers.get("accept") || "*/*" },
  }));
  const headers = new Headers(response.headers);
  headers.set("cache-control", path === "/artifact-manifest.json" ? "no-store"
    : path.endsWith(".html") || path.endsWith(".js") || path.endsWith(".css")
    ? "no-cache" : "public, max-age=300");
  if (path === "/public-shell/sw.js") headers.set("service-worker-allowed", "/");
  let body = response.body;
  // The old offline Tour shell loads this module at startup but never caches it.
  if (response.ok && engineSignIn(env) && path === '/js/ui-switcher-history.generated.js') {
    headers.delete('content-length');
    headers.delete('etag');
    if (request.method === 'GET') body = `if (location.pathname === '/tours/day.html') location.replace('/tours' + location.search);
${await response.text()}`;
  }
  const asset = secure(new Response(body, { status: response.status, statusText: response.statusText, headers }), path);
  if (request.method !== 'GET' || !asset.ok || !path.endsWith('.html')) return asset;
  const { homeToday, dealsFromEngine, dealSavesFromEngine, clientsVendorsFromEngine, dealToursFromEngine } = switches ?? await pageSwitches(env);
  const tourPlanner = path === '/pipeline.html' && dealToursFromEngine;
  const partnerSignIn = engineSignIn(env);
  const vendorTerritoryTiles = new URL(request.url).pathname === '/vendors'
    && (clientsVendorsFromEngine || partnerSignIn) && await switchedOn(env, 'vendor-territory-tiles');
  if (!partnerSignIn && !homeToday && !dealsFromEngine && !dealSavesFromEngine && !clientsVendorsFromEngine && !tourPlanner) return asset;
  const date = dealSavesFromEngine && ['/pipeline.html', '/lease-anniversaries.html', '/workspace.html', '/inbox.html'].includes(path)
    ? await env.ENGINE_ROUTING.get('deal-cutover-date', { cacheTtl: 30 }).catch(() => null)
    : null;
  return new HTMLRewriter().on('html', {
    element(node) {
      if (homeToday) node.setAttribute('data-home-today-from-engine', '');
      if (partnerSignIn) {
        node.setAttribute('data-updates-from-engine', '');
        node.setAttribute('data-partner-sign-in', 'engine');
      }
      if (clientsVendorsFromEngine) node.setAttribute('data-clients-vendors-from-engine', '');
      if (vendorTerritoryTiles) node.setAttribute('data-vendor-territory-tiles', '');
      if (tourPlanner) node.setAttribute('data-deal-tours-from-engine', '');
      if (dealsFromEngine) node.setAttribute('data-deals-from-engine', '');
      if (dealSavesFromEngine) node.setAttribute('data-deals-saves-from-engine', /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '');
    },
  }).transform(asset);
}

async function carrResponse(request, env, documentRequest = false) {
  if (engineSignIn(env)) return json({ error: 'not_available_yet' }, 404);
  if (!env?.CARR?.fetch) return unavailable(documentRequest);
  try {
    const response = await env.CARR.fetch(new Request(request, { redirect: "manual" }));
    return response;
  } catch {
    return unavailable(documentRequest);
  }
}

function copySessionCookies(from, to) {
  const values = typeof from.headers.getSetCookie === "function"
    ? from.headers.getSetCookie() : [from.headers.get("set-cookie")].filter(Boolean);
  if (!values.length) return to;
  const headers = new Headers(to.headers);
  for (const value of values) headers.append("set-cookie", value);
  return new Response(to.body, { status: to.status, statusText: to.statusText, headers });
}

const isString = value => typeof value === 'string';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const DEALS = 'deals-from-engine';
const NEXT_DEAL_SAVES = 'deals-saves-from-engine';
const DEAL_TOURS = 'deal-tours-from-engine';
const LEADS = 'leads-from-engine';
const HOME = 'home';
const HOME_TODAY = '/api/engine/home/today';
const LEGACY_HOME_MARKS = new Set(['snooze-home-inbox', 'settle-home-inbox', 'unsettle-home-inbox']);
const HOME_WRITES = new Map([
  ['end-engine-home-step', ['next-steps', 'end']],
  ['reopen-engine-home-step', ['next-steps', 'reopen']],
  ['decide-engine-home-proposal', ['proposals', 'decision']],
  ['edit-engine-home-draft', ['reply-drafts', 'edit']],
  ['dismiss-engine-home-draft', ['reply-drafts', 'dismissal']],
  ['submit-engine-home-draft', ['reply-drafts', 'submission']],
]);
const homeDetail = (path, query = {}) => ({ key: HOME, path: '/api/engine/' + path, segment: 'id', engineOnly: true,
  args: { id: value => isUuid(value), ...query }, accepts: ({ id }) => isUuid(id) });
const INVOICES = 'invoices-from-engine';
const CHARTS = 'charts-from-engine';
const NATIONAL_DEALS = 'national-deals-from-engine';
const SEARCH = 'search-from-engine';
const CLIENTS_VENDORS = 'clients-vendors-from-engine';
const RELATIONSHIPS = 'relationships-from-engine';
const ENGINE_SIGN_IN_KEYS = new Set([DEALS, NEXT_DEAL_SAVES, LEADS, CLIENTS_VENDORS, RELATIONSHIPS, SEARCH, INVOICES, CHARTS]);
// Each old read the engine can answer, by tool name or business GET path: its
// switch key, its engine path and, for a tool, a check per argument.
// A `segment` argument becomes the last path segment. `search` seeds fixed query parameters.
// A business GET keeps its query text and, unless listOnly, its record id. The engine checks both.
const ENGINE_READS = new Map([
  ['deal-room-board', { key: DEALS, path: '/api/engine/deals', args: { workspace: isString, account_client_id: isString } }],
  ['get-deal-room', { key: DEALS, path: '/api/engine/deals', segment: 'deal', args: { deal: isString },
    accepts: ({ deal }) => !['', '.', '..', undefined].includes(deal) }],
  ['get-call-context', { key: DEALS, path: '/api/engine/call-context', partnerSignInOnly: true,
    args: { deal_ids: ids => Array.isArray(ids) && ids.length > 0 && ids.length <= 50 && ids.every(isUuid) },
    accepts: ({ deal_ids }) => Boolean(deal_ids),
    query: ({ deal_ids }) => new URLSearchParams(deal_ids.map(id => ['deal_id', id])).toString() }],
  ['search-parties-v1', { key: DEALS, path: '/api/engine/parties/search', search: 'kind=person',
    args: { query: isString }, accepts: ({ query }) => Boolean(query?.trim()) }],
  // Without the workspace the old tool answers Home's legacy board, which the engine does not serve.
  ['lead-board', { key: LEADS, path: '/api/engine/leads', accepts: ({ workspace }) => workspace === 'leads',
    args: { workspace: isString, lead_id: isString, correspondence_cursor: isObject, stage_history_cursor: isString } }],
  ['quiet-follow-ups', { key: LEADS, path: '/api/engine/quiet-follow-ups', args: { lead_days: Number.isFinite, vendor_days: Number.isFinite, owner_slug: isString } }],
  ['list-practice-origination', { key: LEADS, path: '/api/engine/reasons-to-reach-out', args: { limit: Number.isFinite, before_id: isString } }],
  [HOME_TODAY, { key: HOME, path: HOME_TODAY, engineOnly: true }],
  ['read-home-inbox-v5', { key: HOME, path: '/api/engine/home/inbox', args: {}, engineOnly: true }],
  ['read-engine-home-proposal', homeDetail('proposals', { deal_id: value => isUuid(value) })],
  ['read-engine-home-draft', homeDetail('reply-drafts')],
  ['read-engine-home-card', { key: HOME, path: '/api/engine/home/cards', segment: 'item_id', engineOnly: true,
    args: { item_id: isHomeReviewId }, accepts: ({ item_id }) => isHomeReviewId(item_id) }],
  ['read-invoice-tracker', { key: INVOICES, path: '/api/engine/invoices', args: {} }],
  ['ideal-client-profile', { key: CHARTS, path: '/api/engine/client-fit', args: { vertical: isString, city: isString, state: isString } }],
  ['capture-queue', { key: NATIONAL_DEALS, path: '/api/engine/capture-queue', args: {}, usedOnDeals: true }],
  // The old tool answers an empty query and the engine refuses it, so only a nonempty one moves.
  ['find', { key: SEARCH, path: '/api/engine/find', args: { query: isString }, accepts: ({ query }) => Boolean(query) }],
  ['find-and-catch-up', { key: CLIENTS_VENDORS, path: '/api/engine/recent-activity', args: { query: isString, limit: Number.isFinite, ref: isString } }],
  ['read-vendor-meetings', { key: CLIENTS_VENDORS, path: '/api/engine/vendor-meetings', args: { view: isString, q: isString, limit: Number.isFinite, cursor: isString } }],
  ['/api/v1/business/clients', { key: CLIENTS_VENDORS, path: '/api/engine/clients' }],
  ['/api/v1/business/vendors', { key: CLIENTS_VENDORS, path: '/api/engine/vendors' }],
  ['/api/v1/business/vendors/summary', { key: CLIENTS_VENDORS, path: '/api/engine/vendors/summary', listOnly: true }],
  ['/api/v1/business/relationships', { key: RELATIONSHIPS, path: '/api/engine/relationships', listOnly: true }],
]);
const BUSINESS_GET = /^(\/api\/v1\/business\/(?:vendors\/summary|[a-z]+))(\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;

const isCalendarAnswer = (verb, args) => verb === 'answer-board-question' && args?.board_id === 'calendar-agenda';

function effectiveMcpVerb(params) {
  const { name, arguments: supplied } = params ?? {};
  const wrapped = name === 'call-verb';
  const verb = wrapped ? supplied?.verb : name;
  let args = wrapped ? supplied?.args : supplied;
  if (wrapped && isString(args)) {
    try { args = JSON.parse(args); } catch { args = null; }
  }
  return { verb, args };
}

async function mcpCall(request, url) {
  if (request.method !== 'POST' || url.pathname !== '/mcp') return null;
  try { return await request.clone().json(); } catch { return null; }
}

// The old system's tools/call reply around an engine answer's exact text.
function mcpReply(call, response, text, isError) {
  const content = [{ type: 'text', text }];
  return copySessionCookies(response, json({ jsonrpc: '2.0', id: call.id ?? null, result: isError ? { isError, content } : { content } }));
}

async function legacyInvoiceReceipt(response) {
  if (!response.ok) return response;
  try {
    const envelope = await response.clone().json();
    const content = envelope?.result?.content?.[0];
    const receipt = JSON.parse(content?.text);
    if (!isObject(receipt) || !Object.hasOwn(receipt, 'engine_receipt')) return response;
    delete receipt.engine_receipt;
    content.text = JSON.stringify(receipt);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(JSON.stringify(envelope), { status: response.status, statusText: response.statusText, headers });
  } catch { return response; }
}

// The registered read a request asks for: a business GET, or a tool call with its arguments.
function engineRead(request, url, call) {
  if (request.method === 'GET') {
    const [, path, record = ''] = BUSINESS_GET.exec(url.pathname) ?? [null, url.pathname];
    const read = ENGINE_READS.get(path);
    return read && !(read.listOnly && record) ? { read, record } : null;
  }
  const read = call?.method === 'tools/call' && ENGINE_READS.get(call.params?.name);
  const args = call?.params?.arguments === undefined ? {} : call.params.arguments;
  if (!read?.args || !isObject(args)
      || Object.entries(args).some(([key, value]) => !Object.hasOwn(read.args, key) || !read.args[key](value))
      || (read.accepts && !read.accepts(args))) return null;
  return { read, args };
}

async function switchedOn(env, key) {
  try { return await env?.ENGINE_ROUTING?.get(key, { cacheTtl: 30 }) === 'on'; } catch { return false; }
}

function routeToEngine(env, key, usedOnDeals = false) {
  if (key === HOME) return homeOnEngine(env);
  if (engineSignIn(env) && (usedOnDeals || ENGINE_SIGN_IN_KEYS.has(key))) return true;
  return switchedOn(env, key);
}

const FALLBACK_DEADLINE_MS = 2_000;
// The app's own deadline for these reads in js/live-client.js and js/leads-client.js.
const READ_DEADLINE_MS = 10_000;

async function engineResponse(request, env, call) {
  const url = new URL(request.url);
  const asked = engineRead(request, url, call);
  if (!asked) {
    if (engineSignIn(env) && call?.method === 'tools/call' && ENGINE_READS.get(call.params?.name)?.key === DEALS)
      return saveRefusal(call, 'invalid_arguments', 'Reload Deals and try again.');
    return null;
  }
  const { read, args, record } = asked;
  if (read.partnerSignInOnly && !engineSignIn(env)) return null;
  if (!await routeToEngine(env, read.key, read.usedOnDeals)) return null;
  let cutover;
  const cutoverOn = () => cutover ??= routeToEngine(env, NEXT_DEAL_SAVES);
  // Only a read the old system may still answer is cut short to leave it time;
  // under engine sign-in nothing can, so the engine gets the reader's whole deadline.
  const engineOnly = engineSignIn(env) || read.engineOnly;
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'origin_mismatch' }, 403);
  const headers = new Headers();
  for (const key of ['cookie', 'origin']) {
    const value = request.headers.get(key);
    if (value !== null) headers.set(key, value);
  }
  if (call?.params.name === 'find' && request.headers.get('x-doctorcre-search') === 'search.v1')
    headers.set('x-doctorcre-search', 'search.v1');
  const controller = new AbortController();
  let timer;
  let reader;
  try {
    if (call) {
      url.pathname = read.segment ? `${read.path}/${encodeURIComponent(args[read.segment])}` : read.path;
      if (read.query) url.search = read.query(args);
      else {
        url.search = read.search ?? '';
        // The engine takes the old tool's arguments as query text, an object as its JSON.
        for (const [key, value] of Object.entries(args)) {
          if (key !== read.segment) url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
      }
    } else url.pathname = read.path + record;
    const response = await Promise.race([
      (async () => {
        const response = await engineFetch(new Request(url, { headers, signal: controller.signal, redirect: 'manual' }), env);
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          return null;
        }
        if ([401, 403, 429].includes(response.status)) return response;
        if (response.status >= 500 || (response.status !== 200 && response.status < 400)) {
          void response.body?.cancel().catch(() => {});
          return null;
        }
        reader = response.body?.getReader();
        const chunks = [];
        const decoder = new TextDecoder();
        if (reader) {
          // eslint-disable-next-line no-restricted-syntax -- Engine body reads stop when the read deadline cancels this reader.
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(decoder.decode(value, { stream: true }));
          }
        }
        chunks.push(decoder.decode());
        let text = chunks.join('');
        if (!call) {
          if (engineSignIn(env) && read.key === RELATIONSHIPS && response.ok) {
            text = JSON.stringify({ ...JSON.parse(text), can_request_introductions: false });
          }
          return copySessionCookies(response, new Response(text, { status: response.status, headers: JSON_HEADERS }));
        }
        if (call.params.name === 'deal-room-board' && response.ok) {
          const board = JSON.parse(text);
          if (board?.schema_version === 'local-deals-board.v2') {
            const saves = await cutoverOn();
            const prospects = saves && (!engineSignIn(env) ||
              (await switchedOn(env, DEALS) && await switchedOn(env, NEXT_DEAL_SAVES)));
            text = JSON.stringify({ ...board, board_from_engine: true,
              ...(prospects ? { engine_prospects: true } : {}), ...(saves ? { next_deal_saves: true } : {}) });
          }
        }
        if (call.params.name === 'get-deal-room' && response.ok) {
          const detail = JSON.parse(text);
          if (isEngineDealDetail(detail) && await cutoverOn()) {
            text = JSON.stringify({ ...detail, next_deal_saves: true });
          }
        }
        if (call.params.name === 'read-home-inbox-v5' && response.ok) {
          const inbox = JSON.parse(text);
          if (inbox?.schema_version === 'home-inbox.v5') text = JSON.stringify({ ...inbox, engine_marks: true });
        }
        return mcpReply(call, response, text, response.status >= 400);
      })(),
      new Promise(resolve => {
        // eslint-disable-next-line no-restricted-syntax -- One engine deadline per read, cleared when the response settles.
        timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        resolve(null);
      }, engineOnly ? READ_DEADLINE_MS : FALLBACK_DEADLINE_MS); }),
    ]);
    if (response) return response;
  } catch { /* The switch below decides whether this read can fall back. */ }
  finally { clearTimeout(timer); reader?.releaseLock(); }
  return engineOnly || await cutoverOn() ? json({ error: 'engine_unavailable' }, 503) : null;
}

// New-schema receipts are separate from the legacy tool receipts.
const CUTOVER_SAVES = new Set([
  'patch-deal-field', 'update-deal', 'set-next-step', 'complete-deal-item', 'record-deal-item',
  'add-deal-note', 'new-deal', 'set-market-agent', 'add-critical-date',
  'remove-deal-participant', 'confirm-critical-date', 'resolve-critical-date',
  'instruct-deal-item', 'revert-deal-field', 'resolve-conflict', 'undo-invoice-close', 'undo-automatic-phase-move',
  'create-national-account', 'set-national-account-owner', 'create-national-market-deal',
]);
const isUuid = value => isString(value) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function isHomeReviewId(value) {
  if (!isString(value)) return false;
  const [kind, id, extra] = value.split(':');
  return (kind === 'suggestion' || kind === 'reply_draft') && isUuid(id) && extra === undefined;
}

function nextDealSave(verb, args) {
  const { deal, idempotency_key, seen_change_id, field, value } = args;
  if (!isUuid(idempotency_key)) return null;
  const post = (path, body) => ({ path: '/api/engine' + path, body: { idempotency_key, ...body } });
  if (verb === 'new-deal') {
    const { name, client_id, prospect_id, owner, phase, kind, reason, market_id, renews_lease_id } = args;
    if (!isUuid(client_id) || (prospect_id !== undefined && !isUuid(prospect_id))) return null;
    return post('/deals', { name, client_id, prospect_id, owner, phase, kind, reason, market_id, renews_lease_id });
  }
  if (verb === 'create-national-market-deal') {
    const { account_client_id, market_id, name, owner, phase, reason, client_id, new_location, market_agent_id } = args;
    if (!isUuid(account_client_id) || !isUuid(market_id)) return null;
    return post('/deals', { national_account_id: account_client_id, market_id, name, owner, phase, reason,
      client_id, new_location, market_agent_id });
  }
  if (verb === 'create-national-account') {
    const { name, owner, company_id, force_new } = args;
    return post('/national-accounts', { name, owner, company_id, force_new });
  }
  if (verb === 'set-national-account-owner') {
    const { account_client_id, owner, base_version } = args;
    return isUuid(account_client_id) ? post(`/national-accounts/${account_client_id}/owner`, { owner, base_version }) : null;
  }
  if (!isUuid(deal)) return null;
  const changes = patch => post(`/deals/${deal}/changes`, { seen_change_id, ...patch });
  switch (verb) {
    case 'undo-automatic-phase-move':
      return isUuid(args.event_id) ? post(`/deals/${deal}/phase/undo`, {
        event_id: args.event_id, base_version: seen_change_id,
      }) : null;
    case 'undo-invoice-close':
      return isUuid(args.invoice_id) ? post(`/invoice-emails/${args.invoice_id}/undo`) : null;
    case 'set-market-agent':
    case 'remove-deal-participant': {
      const party_id = verb === 'set-market-agent' ? args.agent_party_id : args.party_id;
      const role = verb === 'set-market-agent' ? 'market_agent' : args.role;
      if (!isUuid(party_id)) return null;
      const suffix = verb === 'remove-deal-participant' ? '/remove' : '';
      return post(`/deals/${deal}/parties${suffix}`, { party_id, role });
    }
    case 'add-critical-date': {
      const { kind, due_on, source, note } = args;
      return post(`/deals/${deal}/critical-dates`, { kind, due_on, source, note });
    }
    case 'confirm-critical-date':
    case 'resolve-critical-date': {
      const { critical_date_id, resolution, reason } = args;
      if (!isUuid(critical_date_id)) return null;
      return verb === 'confirm-critical-date'
        ? post(`/critical-dates/${critical_date_id}/confirm`, {})
        : post(`/critical-dates/${critical_date_id}/resolve`, { resolution, reason });
    }
    case 'update-deal': {
      const { outcome, closed_on, won_value, lost_reason } = args.fields || {};
      const from = args.phase_from;
      if (from !== null && !isString(from)) return null;
      if (outcome === 'won') return changes({
        phase: { from, to: 'closed', on: closed_on },
        ...(won_value != null && { fields: { closed_value: won_value } }),
      });
      if (outcome === 'lost') return changes({ phase: { from, to: 'dead', on: closed_on, reason: lost_reason } });
      return null;
    }
    case 'patch-deal-field':
      if (field === 'phase' && value !== 'closed' && (args.phase_from === null || isString(args.phase_from))) {
        const reason = isString(args.change_reason) ? args.change_reason : undefined;
        return changes({ phase: { from: args.phase_from, to: value, reason } });
      }
      if (field === 'owner' && isString(value) && value) return changes({ fields: { owner: value } });
      if (field === 'market' && (value === null || isUuid(value))) return changes({ fields: { market_id: value } });
      if (field === 'operating_state' && value?.state === 'parked') {
        return changes({ fields: { parking_reason: value.reason, parking_note: value.note || null } });
      }
      if (field === 'operating_state' && value?.state === 'active') {
        return changes({ fields: { parking_reason: null, parking_note: null } });
      }
      return null;
    case 'set-next-step':
      return post('/next-steps', { deal_id: deal, what: args.text, due_on: args.next_date ?? undefined,
        replaces: 'current', seen_current_step: args.seen_current_step });
    case 'complete-deal-item':
      return isUuid(args.item_id) ? post(`/next-steps/${args.item_id}/end`, {
        resolution: 'done', base_version: args.base_version,
      }) : null;
    case 'record-deal-item':
      return post('/next-steps', { deal_id: deal, what: args.title, due_on: args.due_on ?? undefined,
        item: { title: args.title, bullets: args.bullets, source_ref: args.source_ref } });
    case 'add-deal-note':
      return post('/activities', { kind: 'note', happened_at: args.happened_at, about: [{ deal_id: deal }], summary: args.text });
    default:
      return null;
  }
}

function saveRefusal(call, error, hint) {
  return mcpReply(call, new Response(null), JSON.stringify({ error, hint }), true);
}

const DEAL_CREATE_REFUSALS = new Map([
  ['deal_party_party_id_fkey', 'Choose an existing client.'],
  ['deal_party_client_is_a_client', 'Choose an existing client.'],
  ['deal_market_id_fkey', 'Choose an existing market.'],
  ['deal_renewal_names_lease', 'Choose an existing lease to renew.'],
  ['deal_renews_lease_id_fkey', 'Choose an existing lease to renew.'],
  ['deal_name_exists', 'A deal with this name already exists.'],
  ['not_a_prospect', 'This person or company is no longer a prospect.'],
  ['lead_or_client_how_found', 'Record how you found this person or company before using them as a client.'],
  ['location_not_in_account', 'This location is no longer in the account. Reopen Add market deal to choose a location.'],
  ['location_name_exists', 'Choose the existing location with that name.'],
]);

function dealPeopleAndDateHint(name, body) {
  const rule = body.error === 'database_refused_the_statement' ? body.rule : body.error;
  switch (rule) {
    case 'deal_party_pkey': return 'This person or company already has that role on the deal.';
    case 'deal_party_party_id_fkey': return 'Choose an existing person or company.';
    case 'deal_party_role_fkey': return 'Choose a role for this person or company.';
    case 'critical_date_status_moves': return 'This date cannot be marked that way.';
    case 'invalid_field_value':
    case 'missing_required':
      if (name === 'add-critical-date') return 'Enter a valid date and where it came from.';
      if (name === 'resolve-critical-date') return 'Choose how to mark this date and enter a reason.';
      break;
    case 'not_found':
      if (name === 'remove-deal-participant') return 'That person or company is no longer in that role on the deal.';
      if (name.endsWith('-critical-date') && name !== 'add-critical-date') return 'That date is no longer on the deal.';
      break;
    case 'version_conflict':
      if (name === 'confirm-critical-date' || name === 'resolve-critical-date') return 'Reload the deal to see the current state of this date.';
      return 'Reload the deal before saving again.';
  }
  return null;
}

async function cutoverSave(request, env, call) {
  const { name, arguments: args } = call.params;
  const on = await routeToEngine(env, NEXT_DEAL_SAVES);
  const marketDeal = name === 'create-national-market-deal';
  const creating = name === 'new-deal' || marketDeal;
  const accountSave = name === 'create-national-account' || name === 'set-national-account-owner';
  const fromNext = creating || accountSave ? args.next_deal_save === true
    : Number.isSafeInteger(args.seen_change_id) && args.seen_change_id >= 0;
  const phaseUndo = name === 'undo-automatic-phase-move';
  if (phaseUndo && (!on || !fromNext)) return saveRefusal(call, 'version_conflict', 'Reload Deals before using Undo.');
  const conversion = name === 'new-deal' && args.prospect_id !== undefined;
  if (!on && !fromNext && !conversion) return null;
  if (creating && (!on || !fromNext)) return saveRefusal(call, 'reload_deals', 'Reload Deals before adding a deal.');
  if (accountSave && (!on || !fromNext || !await routeToEngine(env, DEALS)))
    return saveRefusal(call, 'reload_deals', 'Reload Deals before saving the account.');
  if (!accountSave && on && !await routeToEngine(env, DEALS)) return saveRefusal(call, 'version_conflict', 'Reload the deal before saving.');
  if (on && name === 'complete-deal-item' && (!Number.isSafeInteger(args.base_version) || args.base_version < 0))
    return saveRefusal(call, 'version_conflict', 'Reload the item before marking it done.');
  const save = nextDealSave(name, args);
  if (on && !save) return saveRefusal(call, 'deal_save_unavailable', name === 'set-market-agent' && fromNext
    ? 'Choose an existing person as the market agent.' : 'This change is temporarily unavailable.');
  // A retained request may outlive a switch change. Its snapshot pins the destination.
  if (!on || !fromNext) return saveRefusal(call, 'version_conflict', 'Reload the deal before saving.');
  const response = await sendEngineSave(request, env, save.path, save.body);
  if (!response || response.status >= 500) return unavailable(false);
  if ([401, 403, 429].includes(response.status)) return response;
  const body = await response.json().catch(() => null);
  if (!isObject(body)) return unavailable(false);
  if (!response.ok) {
    if (phaseUndo && body.error === 'version_conflict'
        && body.hint === 'Undo would return this deal to Closed deals or Lost deals.') {
      return saveRefusal(call, 'undo_returns_to_ended_deals', body.hint);
    }
    if (name === 'create-national-account' && body.error === 'account_name_exists' && !args.force_new && !args.company_id) {
      return mcpReply(call, response, JSON.stringify({
        needs_confirm: true, candidates: body.candidates,
        hint: 'This name is already on file. Choose a company below or confirm that you want to add a separate company.',
      }), false);
    }
    if (name === 'undo-invoice-close' && body.rule === 'invoice_email_undo_current') body.error = 'version_conflict';
    const peopleOrDate = name === 'set-market-agent' || name === 'remove-deal-participant' || name.endsWith('-critical-date');
    const badMarketAgent = marketDeal && body.error === 'invalid_field_value' && Array.isArray(body.fields) && body.fields.includes('market_agent_id');
    const invalidClosingDate = name === 'update-deal' && body.error === 'invalid_field_value'
      && Array.isArray(body.fields) && body.fields.length === 1 && body.fields[0] === 'phase';
    const hint = accountSave
      ? body.error === 'version_conflict' ? 'This account changed. Reload Deals before saving the owner.'
        : body.error === 'already_national_account' ? 'This company is already a national account.'
        : body.error === 'not_found' ? args.company_id
          ? 'That company is no longer available. Choose another company or edit the account details.'
          : 'This account is no longer available.'
        : name === 'set-national-account-owner' ? 'Choose Joe or Dell as the owner.'
        : 'Check the company name and choose Joe or Dell as the owner.'
      : badMarketAgent ? 'Choose an existing person as the market agent.'
      : marketDeal && body.error === 'not_found' ? 'This national account is no longer available.'
      : creating
      ? DEAL_CREATE_REFUSALS.get(body.error === 'database_refused_the_statement' ? body.rule : body.error)
        ?? 'Check the deal details and try again.'
      : invalidClosingDate ? 'Choose a closing date between the day the deal reached its current phase and today.'
      : peopleOrDate ? dealPeopleAndDateHint(name, body) ?? 'Review the deal and try saving again.'
      : ['undo-invoice-close', 'undo-automatic-phase-move'].includes(name) && typeof body.hint === 'string' && body.hint.trim() ? body.hint
      : body.error === 'version_conflict' && name === 'complete-deal-item' ? 'This item changed while it was open. Reload it before marking it done.'
      : body.error === 'version_conflict' ? name === 'set-next-step'
        ? 'The next step changed. Review it before saving again.' : 'This deal changed. Reload the deal before saving.'
      : body.error === 'invoice_already_paid' ? 'The invoice has been paid, so the close cannot be undone.'
      : body.error === 'step_ended' ? 'This step was already closed. Reload the deal to see its current steps.'
      : 'The change could not be saved. Review the deal and try again.';
    return mcpReply(call, response, JSON.stringify({ ...body, hint }), true);
  }
  const saved = accountSave ? isUuid(body.account_client_id) && body.owner === args.owner
      && (name === 'create-national-account' ? !args.company_id || body.account_client_id === args.company_id
        : body.account_client_id === args.account_client_id)
    : creating ? isUuid(body.deal_id) && Number.isSafeInteger(body.change_id) && body.change_id >= 0
    : phaseUndo ? body.deal_id === args.deal && isString(body.phase) && isString(body.phase_changed_at)
    : name === 'undo-invoice-close' ? body.invoice_id === args.invoice_id && body.status === 'undone'
    : save.path.endsWith('/changes') ? body.deal_id === args.deal
    : save.body.party_id ? body.deal_id === args.deal && body.party_id === save.body.party_id && body.role === save.body.role
    : name.endsWith('-critical-date') ? isUuid(body.critical_date_id)
      && (name === 'add-critical-date' || body.critical_date_id === args.critical_date_id)
      && body.status === (name === 'resolve-critical-date' ? args.resolution : 'open')
    : save.path.endsWith('/activities') ? isUuid(body.activity_id) : isUuid(body.next_step_id);
  if (!saved || body.error) return unavailable(false);
  return mcpReply(call, response, JSON.stringify({ ...body, ok: true }), false);
}

const DEAL_SAVES = 'deal-saves-to-engine';
// Each old save the engine can answer, by tool name: its switch key and engine path.
const ENGINE_SAVES = new Map([
  ['patch-deal-field', { key: DEAL_SAVES, path: '/api/engine/patch-deal-field' }],
  ['update-deal', { key: DEAL_SAVES, path: '/api/engine/update-deal' }],
]);
const LEAD_ACTIONS = new Map([
  ['claim-lead', 'claim'],
  ['acknowledge-lead-email', 'acknowledge_email'],
  ['update-lead', 'stage'],
  ['link-lead-client', 'link'],
]);

async function routeLeadSave(request, env, call, action) {
  const { lead_id, ...legacy } = call.params.arguments;
  const saveToEngine = await routeToEngine(env, NEXT_DEAL_SAVES);
  if (!saveToEngine || !isUuid(lead_id) || !await routeToEngine(env, LEADS)) {
    if (engineSignIn(env)) return saveRefusal(call, 'invalid_arguments', 'Reload Leads.');
    if (action === 'acknowledge_email') return saveRefusal(call, 'lead_routing_changed', 'Reload Leads.');
    if (saveToEngine || lead_id === undefined) return null;
    const params = { ...call.params, arguments: legacy };
    return carrResponse(new Request(request, { body: JSON.stringify({ ...call, params }) }), env);
  }

  const { base_version, expected_actor, idempotency_key, fields, stage_review, client_id, confirmed } = legacy;
  const body = { action, base_version, expected_actor, idempotency_key };
  if (action === 'stage') {
    if (!isObject(fields) || Object.keys(fields).length !== 1 || !isString(fields.stage) ||
        stage_review?.undo_event_id !== undefined) {
      return engineSignIn(env) ? saveRefusal(call, 'invalid_arguments', 'Reload Leads.') : null;
    }
    body.stage = fields.stage;
    if (body.stage === 'archived') body.reason = stage_review?.reason;
  }
  if (action === 'link') Object.assign(body, { client_id, confirmed });
  return engineAnswer(request, env, call, { path: `/api/engine/leads/${lead_id}/changes` },
    { allowHandoff: false, body, uncertainServerError: true });
}

// Engine refusals that wrote nothing and leave the answer to the old system: a
// save it cannot make, or a key the old system's receipt holds.
const OLD_SYSTEM_ANSWERS = new Map([[501, 'old_system_required'], [409, 'key_reuse']]);
const DEAL_EMAIL_REFUSALS = new Map([
  ['open_step_exists', 'You already have an open step on this deal. Finish or change it first, or dismiss this suggestion.'],
  ['database_refused_the_statement', 'This email can’t be filed on this deal. Dismiss this suggestion.'],
  ['invalid_field_value', 'Check the suggestion and any changes you made, or dismiss it.'],
  ['version_conflict', 'This deal has moved since the suggestion. Dismiss it.'],
  ['already_decided', 'This suggestion is already gone. Reload the deal to see what remains.'],
  ['not_found', 'This suggestion is already gone. Reload the deal to see what remains.'],
]);

// The switch picks which system takes a save first. Each replays only its own
// receipt and refuses the other's as key_reuse, so a retry that crossed the
// switch goes on to the other one. Both read the key's receipt before writing,
// and tool_call's primary key refuses a second one, so the second replays or
// refuses and never writes.
async function engineSave(request, env, call) {
  if (call?.method !== 'tools/call') return null;
  if (!isObject(call.params?.arguments)) {
    if (engineSignIn(env) && CUTOVER_SAVES.has(call.params?.name))
      return saveRefusal(call, 'invalid_arguments', 'Reload the deal before saving.');
    return null;
  }
  const leadAction = LEAD_ACTIONS.get(call.params.name);
  if (leadAction) return routeLeadSave(request, env, call, leadAction);
  if (call.params.name === 'decide-engine-deal-email') {
    if (!await routeToEngine(env, DEALS) || !await routeToEngine(env, NEXT_DEAL_SAVES))
      return saveRefusal(call, 'deal_email_routing_changed', 'Reload the deal before reviewing this suggestion.');
    const { proposal_id, decision, idempotency_key, edits } = call.params.arguments;
    if (!isUuid(proposal_id) || !isUuid(idempotency_key) || !['accept', 'dismiss'].includes(decision)
        || (edits !== undefined && (decision !== 'accept' || !isObject(edits))))
      return saveRefusal(call, 'invalid_arguments', 'Choose a suggestion to review.');
    const response = await sendEngineSave(request, env, `/api/engine/proposals/${proposal_id}/decision`, {
      decision, idempotency_key, ...(edits && { edits }),
    });
    if (!response || response.status >= 500) return unavailable(false);
    if ([401, 403, 429].includes(response.status)) return response;
    const body = await response.json().catch(() => null);
    if (!isObject(body)) return unavailable(false);
    if (!response.ok) {
      const error = isString(body.error) ? body.error : 'suggestion_refused';
      const hint = DEAL_EMAIL_REFUSALS.get(error) ?? 'This suggestion could not be saved. Review the linked record or dismiss the suggestion.';
      return mcpReply(call, response, JSON.stringify({ ...body, error, hint }), true);
    }
    if (body.error || body.proposal_id !== proposal_id || body.status !== (decision === 'accept' ? 'accepted' : 'dismissed'))
      return unavailable(false);
    return mcpReply(call, response, JSON.stringify({ ...body, ok: true }), false);
  }
  if (call.params.name === 'save-engine-home-mark') {
    if (!homeOnEngine(env)) return saveRefusal(call, 'home_routing_changed', 'Refresh Home and try again.');
    if (!['snooze', 'unsnooze', 'drop', 'done', 'undo_done'].includes(call.params.arguments.action))
      return saveRefusal(call, 'invalid_arguments', 'Refresh Home and choose an available action.');
    return engineAnswer(request, env, call, { path: '/api/engine/home/marks' }, { allowHandoff: false });
  }
  const homeSave = HOME_WRITES.get(call.params.name);
  if (homeSave) {
    const { id, ...body } = call.params.arguments;
    if (!isUuid(id)) return saveRefusal(call, 'not_found', 'Refresh Home and try again.');
    if (!homeOnEngine(env)) return saveRefusal(call, 'home_routing_changed', 'Refresh Home and try again.');
    const [record, action] = homeSave;
    return engineAnswer(request, env, call, { path: `/api/engine/${record}/${id}/${action}` },
      { allowHandoff: false, body, rawClientError: record === 'proposals' });
  }
  if (call.params.name === 'record-commission-receipt') {
    if (!await routeToEngine(env, INVOICES)) return null;
    return engineAnswer(request, env, call, { path: '/api/engine/invoices/mark-paid' }, {
      allowHandoff: false, mapReceipt: receipt => ({ ...receipt, engine_receipt: true }),
    });
  }
  if (CUTOVER_SAVES.has(call.params.name)) {
    const result = await cutoverSave(request, env, call);
    if (result) return result;
  }
  const save = ENGINE_SAVES.get(call.params.name);
  if (!save) return null;
  if (await switchedOn(env, save.key)) return await engineAnswer(request, env, call, save) ?? carrResponse(request, env);
  const old = await carrResponse(request, env);
  if (engineSignIn(env) || await oldRefusal(old.clone()) !== 'key_reuse') return old;
  return await engineAnswer(request, env, call, save) ?? old;
}

const DEAL_PAGE_HINT = 'Open the deal page to work from the current record.';
const HOME_HINT = 'Open Home to review the current work.';
const RETIRED_HOME_READS = new Set(['today-triage', 'calendar-meeting-prep', 'list-email-thread-filings']);
const TOUR_HINT = 'Open Tours on the deal page to view existing tours.';
const MONDAY_HINT = 'Open Monday review from Deals.';
const PROSPECTS_HINT = 'Open Prospects on the Deals board.';
const DOCUMENTS_HINT = 'Open Documents on the deal page.';
const FROZEN_TOOLS = new Map([
  ['start-deal-review', MONDAY_HINT],
  ['review-deal', MONDAY_HINT],
  ['end-deal-review', MONDAY_HINT],
  ['complete-one-action', HOME_HINT],
  ['reopen-one-action', HOME_HINT],
  ['resolve-candidate', HOME_HINT],
  ['resolve-post-call-candidate', HOME_HINT],
  ['review-call-outcome', HOME_HINT],
  ['undo-call-change', HOME_HINT],
  ['snooze-email-proposal', HOME_HINT],
  ['handle-email-proposal', HOME_HINT],
  ['confirm-email-filing', HOME_HINT],
  ['confirm-email-next-step', HOME_HINT],
  ['confirm-email-deal-progress', HOME_HINT],
  ['dismiss-email-proposal', HOME_HINT],
  ['edit-email-draft', HOME_HINT],
  ['submit-email-draft', HOME_HINT],
  ['undo-email-thread-filing', HOME_HINT],
  ['set-notification-preference', 'Open Home to see current updates.'],
  ['log-activity', DEAL_PAGE_HINT],
  ['set-lead', DEAL_PAGE_HINT],
  ['add-deal-participant', DEAL_PAGE_HINT],
  ['register-client-portal', 'Open Client website on the deal page.'],
  ['append-tour-selection-cart-version', TOUR_HINT],
  ['save-deal-space-search-v1', DEAL_PAGE_HINT],
  ['run-deal-space-search-v1', DEAL_PAGE_HINT],
  ['record-human-fact', DOCUMENTS_HINT],
  ['set-client-publication', DOCUMENTS_HINT],
  ['resolve-fact-review', DOCUMENTS_HINT],
  ['start-deal-deliverable', DOCUMENTS_HINT],
  ['finalize-deal-deliverable', DOCUMENTS_HINT],
  ['abandon-deal-deliverable', DOCUMENTS_HINT],
  ['set-deal-deliverable-visibility', DOCUMENTS_HINT],
  ['set-prospect-engagement-status', PROSPECTS_HINT],
  ['claim-lead', PROSPECTS_HINT],
  ['approve-lead-draft', HOME_HINT],
  ['update-lead', PROSPECTS_HINT],
  ['link-lead-client', PROSPECTS_HINT],
  ['new-lead', PROSPECTS_HINT],
  ['update-vendor', 'Open Vendors to see the current records.'],
  ['merge-vendor-rows', 'Open Vendors to see the current records.'],
  ['record-commission-receipt', 'Open Invoices to mark an invoice paid.'],
]);

// New, Edit and Link are on the record only while Clients and Vendors read the engine: [switch on, switch off].
const PARTY_TOOLS = new Map([
  ['new-client', ['Open Clients and choose New client.', 'Open Clients to see the current records.']],
  ['add-party', ['Open Clients or Vendors and choose New client or New vendor.', 'Open Search to find the current record.']],
  ['link-parties', ['Open the client or vendor and choose Link to someone.', 'Open Search to find the current record.']],
  ['update-party-contact', ['Open the client or vendor and choose Edit.', 'Open Search to find the current record.']],
  ['new-vendor', ['Open Vendors and choose New vendor.', 'Open Vendors to see the current records.']],
]);

async function frozenHint(env, verb) {
  const party = PARTY_TOOLS.get(verb);
  if (party) return party[await routeToEngine(env, CLIENTS_VENDORS) ? 0 : 1];
  return FROZEN_TOOLS.get(verb) ?? (CUTOVER_SAVES.has(verb) ? DEAL_PAGE_HINT : null);
}

async function refuseLegacyRequest(request, env, url, call) {
  const { pathname } = url;
  if (call?.method === 'tools/call') {
    const { verb, args } = effectiveMcpVerb(call.params);
    if (RETIRED_HOME_READS.has(verb)) return saveRefusal(call, 'home_routing_changed', HOME_HINT);
    const calendarAnswer = isCalendarAnswer(verb, args) ||
      (verb === 'log-activity' && args?.kind === 'meeting' && Object.hasOwn(args, 'calendar_event_key'));
    if (calendarAnswer && homeOnEngine(env))
      return saveRefusal(call, 'home_routing_changed', 'Refresh Home and answer the question in Today.');
    if ((verb === 'review-deal-update' || LEGACY_HOME_MARKS.has(verb)) && homeOnEngine(env))
      return saveRefusal(call, 'home_routing_changed', 'Refresh Home and try again.');
    const hint = await frozenHint(env, verb);
    return hint && await switchedOn(env, NEXT_DEAL_SAVES) ? saveRefusal(call, 'old_save_closed', hint) : null;
  }
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return null;
  const hint = pathname.startsWith('/api/tours/') && pathname !== '/api/tours/properties/search'
    ? TOUR_HINT
    : /^\/api\/v1\/fact-review\/(comparison|record|resolve)$/.test(pathname)
    ? DOCUMENTS_HINT : null;
  return hint && await switchedOn(env, NEXT_DEAL_SAVES) ? json({ error: hint }, 409) : null;
}

async function sendEngineSave(request, env, path, body) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const key of ['cookie', 'origin', 'sec-fetch-site', 'x-carr-csrf']) {
    const value = request.headers.get(key);
    if (value !== null) headers.set(key, value);
  }
  try {
    return await engineFetch(new Request(new URL(path, request.url), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual' }), env);
  } catch { return null; }
}

// Only the legacy-schema saves share a receipt with CARR.
async function engineAnswer(request, env, call, save, { allowHandoff = true, body = call.params.arguments, rawClientError = false, uncertainServerError = false, mapReceipt } = {}) {
  const response = await sendEngineSave(request, env, save.path, body);
  if (engineSignIn(env) && response?.status === 503) return response;
  if (!response || (uncertainServerError && response.status >= 500)) return unavailable(false);
  let text;
  try {
    if ((rawClientError && response.status >= 400 && response.status < 500) || [401, 403, 429].includes(response.status)) return response;
    text = await response.text();
    if (mapReceipt && response.status === 200) {
      const receipt = JSON.parse(text);
      if (!isObject(receipt)) return unavailable(false);
      text = JSON.stringify(mapReceipt(receipt));
    }
  } catch { return unavailable(false); }
  const handoff = OLD_SYSTEM_ANSWERS.get(response.status);
  if (!engineSignIn(env) && allowHandoff && handoff && handoff === parsedError(text)) return null;
  return mcpReply(call, response, text, response.status !== 200);
}

async function oldRefusal(response) {
  try {
    return parsedError((await response.json()).result?.content?.[0]?.text);
  } catch { return undefined; }
}

function parsedError(text) {
  try { return JSON.parse(text)?.error; } catch { return undefined; }
}

function release(env) {
  const sourceCommit = /^[0-9a-f]{40}$/.test(env?.GIT_SHA || "") ? env.GIT_SHA : null;
  const provider = env?.CF_VERSION_METADATA || {};
  return json({
    service: "doctorcre-app",
    environment: env?.APP_ENV || "unknown",
    source_commit: sourceCommit,
    provider_version_id: provider.id || null,
    provider_version_tag: provider.tag || null,
    provider_version_created_at: provider.timestamp || null,
    carr_contract: { schema: carrSchema, version: carrVersion },
    route_contract: { schema: routeContract.schema, version: routeContract.version },
  });
}

function actionLinkDestination(result) {
  if (!isObject(result) || !isString(result.path)) return null;
  const draftPath = '/api/engine/home/cards/';
  if (result.kind === 'reply_draft' && result.path.startsWith(draftPath)) {
    const card = result.path.slice(draftPath.length);
    return card.startsWith('reply_draft:') && isHomeReviewId(card) ? `/inbox/card/${card}` : null;
  }
  if (result.kind === 'lead' && /^\/leads\?lead=[^&#]+$/.test(result.path)) return result.path;
  return null;
}

function retiredActionLink(ref) {
  if (!/^al1_[A-Za-z0-9_-]{1,120}$/.test(ref)) return false;
  try {
    const encoded = ref.slice(4);
    const decoded = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    return /^(cr|fe):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[A-Za-z0-9_-]{1,32}$/.test(decoded)
      && btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === encoded;
  } catch { return false; }
}

function unavailableActionLink(request) {
  return shellMessage(request, 404, {
    title: 'Link unavailable · DoctorCRE',
    heading: 'This link is no longer available',
    action: '<a href="/">Back to Home</a>',
    style: 'shell-refusal',
  });
}

async function openEngineActionLink(request, env, url) {
  const resolver = new URL(`/api/engine/action-links/${url.pathname.slice(3)}`, url);
  try {
    const response = await engineFetch(new Request(resolver, {
      headers: request.headers,
      signal: request.signal,
    }), env);
    if (response.status === 404) {
      void response.body?.cancel().catch(() => {});
      return unavailableActionLink(request);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return response.status === 401 ? partnerLoginRedirect(url) : signInPage(request);
    }
    const path = actionLinkDestination(await response.json());
    if (!path) return signInPage(request);
    const destination = new URL(path, url);
    if (url.searchParams.get('mode') === 'live') destination.searchParams.set('mode', 'live');
    return copySessionCookies(response, Response.redirect(destination, 302));
  } catch {
    return signInPage(request);
  }
}

function oldToursPage(pathname) {
  try {
    const path = decodeURIComponent(pathname).replace(/\/+$/, '');
    return /^\/tours(?:\.html)?$/i.test(path) ||
      /^\/tours\/(?:[^/]+\/)*[^/.]+(?:\.html)?$/i.test(path);
  } catch { return false; }
}

async function moveOldTours(request, env, url) {
  if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
  const gate = await pageGate(request, env, request);
  if (gate.status !== 200) return gate;
  const deal = url.searchParams.get('deal') ?? url.searchParams.get('deal_id');
  const linked = isUuid(deal);
  const query = new URLSearchParams(linked ? { deal } : { 'tours-moved': '1' });
  if (linked && await switchedOn(env, DEAL_TOURS)) {
    query.set('tab', 'tours');
    const tour = url.searchParams.get('tour');
    if (isUuid(tour)) query.set('tour', tour);
  }
  if (url.searchParams.get('mode') === 'live') query.set('mode', 'live');
  return gatedResponse(gate, new Response(null, { status: 302, headers: { location: `/deals?${query}` } }), env);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (pathname === '/share-target' || pathname === '/share-intake.html') {
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
    return new Response(null, { status: 303, headers: { location: '/deals', 'cache-control': 'no-store' } });
  }
  if (isRetiredPage(pathname)) {
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
    const destination = new URL('/', url);
    const gate = await pageGate(request, env, new Request(destination, request));
    return noStore(gate.status === 200 ? copySessionCookies(gate, Response.redirect(destination, 308)) : gate);
  }
  if (engineSignIn(env) && /^\/api\/v1\/call-sessions(?:\/|$)/.test(pathname))
    return json({ error: 'phone_capture_retired' }, 410);
  if (RETIRED_API.test(pathname)) return json({ error: 'not_found' }, 404);
  if (pathname === "/app-release") return request.method === "GET" ? release(env) : json({ error: "method_not_allowed" }, 405);
  if (REDIRECTS.has(pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    const target = pathname === "/business" && url.searchParams.has("q") ? "/search"
      : pathname === "/business" && url.searchParams.get("charts") === "1" ? "/?view=charts"
      : REDIRECTS.get(pathname);
    const destination = new URL(target, url.origin);
    for (const [key, value] of url.searchParams) if (!destination.searchParams.has(key)) destination.searchParams.append(key, value);
    destination.hash = url.hash;
    if (!engineSignIn(env)) return Response.redirect(destination, 308);
    const targetRequest = new Request(destination, request);
    const gate = await pageGate(request, env, gateRequestFor(targetRequest, destination.pathname));
    if (gate.status !== 200) return gate;
    return gatedResponse(gate, Response.redirect(destination, 308), env);
  }

  if (UNGATED_PAGES.has(pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    return assetResponse(request, env, `/${APP_ROUTES.get(pathname)}`);
  }

  if (engineSignIn(env)) {
    if (oldToursPage(pathname)) return moveOldTours(request, env, url);
    if (pathname === '/tours/day-sw.js') {
      if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
      // Replacing the installed worker releases the cached Tour day page.
      const body = request.method === 'HEAD' ? null : `
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.allSettled(windows.map(client => {
    const url = new URL(client.url);
    if (url.pathname !== '/tours/day.html') return;
    url.pathname = '/tours';
    return client.navigate(url.href);
  }));
  await self.registration.unregister();
})()));
`;
      return secure(new Response(body, { headers: {
        'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store',
      } }), pathname);
    }
  }

  const route = routeKey(actionLinkRoute(pathname));
  const engineActionLink = engineSignIn(env) && route === '/a/:ref';
  const engineChat = (pathname === '/doc-chats' || routeKey(pathname) === '/doc/conversations/:conversation_id/turns/:msg_id') && engineSignIn(env);
  const dealView = pathname === '/deals' ? url.searchParams.get('view') : null;
  const reviewView = dealView === 'review' || dealView === 'dropped-prospect';
  const routeAsset = engineChat ? 'doc-chats.html'
    : reviewView ? 'monday-review.html'
    : dealView === 'national' ? "index.html"
    : pathname === "/" && url.searchParams.get("view") === "charts" ? "charts.html"
    : APP_ROUTES.get(route);
  if (routeAsset) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    const gate = await pageGate(request, env, engineChat ? request : gateRequestFor(request, pathname));
    if (gate.status !== 200) return gate;
    if (route === '/a/:ref' && retiredActionLink(pathname.slice(3))) return gatedResponse(gate, unavailableActionLink(request), env);
    if (engineActionLink) return gatedResponse(gate, await openEngineActionLink(request, env, url), env);
    const switches = await pageSwitches(env);
    if (reviewView && (!switches.dealsFromEngine || !switches.dealSavesFromEngine)) {
      url.searchParams.delete('view');
      return gatedResponse(gate, new Response(null, { status: 302, headers: { location: url.pathname + url.search, 'cache-control': 'no-store' } }), env);
    }
    if (route === '/calls' && engineSignIn(env))
      return gatedResponse(gate, await assetResponse(request, env, '/phone-capture-retired.html', switches), env);
    if (routeAsset === 'review-workflows.html' && switches.homeToday)
      return gatedResponse(gate, await assetResponse(request, env, '/review-workflows-moved.html', switches), env);
    if (routeAsset === 'client-portal.html' && (engineSignIn(env) || switches.dealSavesFromEngine)) {
      const deal = url.searchParams.get('deal');
      if (deal) {
        const query = new URLSearchParams({ deal, tab: 'client-portal' });
        return gatedResponse(gate, new Response(null, { status: 302, headers: {
          location: `/deals?${query}`, 'cache-control': 'no-store',
        } }), env);
      }
      return gatedResponse(gate, await assetResponse(request, env, '/client-website-moved.html', switches), env);
    }
    return gatedResponse(gate, await assetResponse(request, env, `/${routeAsset}`, switches), env);
  }

  const staticAsset = assetPath(pathname);
  if (staticAsset) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    return assetResponse(request, env, staticAsset);
  }

  if (pathname === HOME_TODAY) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return await engineResponse(request, env) ?? json({ error: 'not_found' }, 404);
  }

  if (pathname.startsWith('/api/engine/')) {
    const tourPlanner = /^\/api\/engine\/deals\/[^/]+\/tours(?:\/|$)/.test(pathname) || pathname === '/api/engine/properties/search';
    if (tourPlanner && !await switchedOn(env, DEAL_TOURS)) return json({ error: 'not_found' }, 404);
    if (/^\/api\/engine\/doc\/(turns|conversations)(?:\/|$)/.test(pathname) && !engineSignIn(env))
      return json({ error: 'not_found' }, 404);
    const documentWriteMethod = /^\/api\/engine\/files\/[a-f0-9]{64}$/.test(pathname) ? 'PUT'
      : /^\/api\/engine\/deals\/[^/]+\/documents$/.test(pathname) ? 'POST' : null;
    const allowed = documentWriteMethod ? [documentWriteMethod] : ['GET', 'HEAD', 'POST'];
    if (!allowed.includes(request.method)) {
      const response = json({ error: 'method_not_allowed' }, 405);
      response.headers.set('allow', allowed.join(', '));
      return response;
    }
    const meetingAnswer = request.method === 'POST' &&
      (/^\/api\/engine\/calendar\/reviews\/[a-f0-9]{16}\/dismissal$/.test(pathname)
      || (pathname === '/api/engine/activities' && (await request.clone().json().catch(() => null))?.calendar_review_key !== undefined));
    if (meetingAnswer && !homeOnEngine(env)) return json({ error: 'not_found' }, 404);
    if (request.method === 'POST' && /^\/api\/engine\/next-steps\/[^/]+\/end$/.test(pathname)) {
      if (!await routeToEngine(env, DEALS) || !await routeToEngine(env, NEXT_DEAL_SAVES))
        return json({ error: 'reload_deals' }, 409);
      const command = await request.clone().json().catch(() => null);
      if (!isUuid(command?.idempotency_key) || !Number.isSafeInteger(command?.base_version) || command.base_version < 0)
        return json({ error: 'invalid_arguments' }, 400);
    }
    if (documentWriteMethod && (!await routeToEngine(env, DEALS) || !await routeToEngine(env, NEXT_DEAL_SAVES)))
      return json({ error: 'not_found' }, 404);
    const website = /^\/api\/engine\/deals\/[^/]+\/client-website(\/open)?$/.exec(pathname);
    if (website && (!await routeToEngine(env, DEALS) || (!website[1] && !await routeToEngine(env, NEXT_DEAL_SAVES))))
      return json({ error: 'not_found' }, 404);
    const shareOrigin = website?.[1] ? URL.parse(env?.CLIENT_WEBSITE_ORIGIN ?? '') : null;
    if (website?.[1] && (shareOrigin?.protocol !== 'https:' || shareOrigin.href !== `${shareOrigin.origin}/`))
      return json({ error: 'client_website_origin_unconfigured' }, 503);
    const weeklyReview = /^\/api\/engine\/weekly-reviews(?:\/|$)/.test(pathname);
    const dealRead = ['/api/engine/calendar/critical-dates', '/api/engine/calendar/meetings'].includes(pathname) || pathname === '/api/engine/markets' || /^\/api\/engine\/national-accounts\/[^/]+\/locations$/.test(pathname);
    if ((weeklyReview && (!await switchedOn(env, DEALS) || !await switchedOn(env, NEXT_DEAL_SAVES)))
        || ((dealRead || pathname.startsWith('/api/engine/documents/')) && !await routeToEngine(env, DEALS))
        || (pathname === '/api/engine/leads/counts' && !await routeToEngine(env, LEADS)))
      return json({ error: 'not_found' }, 404);
    const nextDealsOnly = (pathname === '/api/engine/parties/search' && url.searchParams.has('role'))
      || /^\/api\/engine\/clients\/[^/]+\/leases$/.test(pathname)
      || /^\/api\/engine\/deals\/[^/]+\/parties(?:\/remove)?$/.test(pathname)
      || /^\/api\/engine\/introductions(?:\/[0-9a-fA-F-]{36})?$/.test(pathname);
    if (nextDealsOnly && (!await routeToEngine(env, DEALS) || !await routeToEngine(env, NEXT_DEAL_SAVES)))
      return json({ error: 'not_found' }, 404);
    // Party saves and their read land in the new database, so they follow the Clients and Vendors switch.
    const partyDoor = (request.method === 'POST' && /^\/api\/engine\/(?:parties|clients|vendors|party-links|introductions)(?:\/[0-9a-fA-F-]{36})?$/.test(pathname))
      || /^\/api\/engine\/parties\/[0-9a-fA-F-]{36}$/.test(pathname)
      // Link's search names no role, so it reads the new database; a Deals client search names its role.
      || (pathname === '/api/engine/parties/search' && !url.searchParams.has('role'));
    if (partyDoor && !await routeToEngine(env, CLIENTS_VENDORS)) return json({ error: 'not_found' }, 404);
    const prospects = /^\/api\/engine\/prospects(?:\/|$)/.test(pathname);
    const prospectSave = prospects && request.method === 'POST';
    const prospectDestination = prospects && ({
      'POST /api/engine/prospects/note': '/api/engine/activities',
      'POST /api/engine/prospects/follow-up': '/api/engine/next-steps',
      'GET /api/engine/prospects/search': '/api/engine/parties/search',
    })[`${request.method} ${pathname}`];
    const prospectWrite = /^\/api\/engine\/prospects(?:\/[^/]+\/(?:changes|drop))?$/.test(pathname);
    if (prospects && (!await switchedOn(env, DEALS) || !await switchedOn(env, NEXT_DEAL_SAVES) ||
        (prospectSave && !prospectDestination && !prospectWrite)))
      return json({ error: 'not_found' }, 404);
    try {
      const forwarded = new Request(request, { redirect: 'manual' });
      if (prospectDestination) {
        url.pathname = prospectDestination;
        return await engineFetch(new Request(url, forwarded), env);
      }
      const response = await engineFetch(forwarded, env);
      if (shareOrigin && response.ok) {
        const grant = new Response(response.body, response);
        grant.headers.set('x-doctorcre-client-website-origin', shareOrigin.origin);
        return grant;
      }
      if (!weeklyReview || request.method !== 'GET' || !response.ok) return response;
      const review = new Response(response.body, response);
      review.headers.set('x-doctorcre-deal-saves', await switchedOn(env, NEXT_DEAL_SAVES) ? 'on' : 'off');
      return review;
    } catch {
      return json({ error: 'engine_unavailable' }, 503);
    }
  }

  if (engineSignIn(env) && pathname.startsWith('/auth/')) {
    const session = pathname === '/auth/session';
    const referer = session && URL.parse(request.headers.get('referer') ?? '');
    // Older cached day pages must stop before seeing a new identity or issuing a CARR read.
    const retiredDay = referer?.origin === url.origin && referer.pathname === '/tours/day.html';
    const response = retiredDay ? json({ error: 'tour_day_moved' }, 503)
      : await authResponse(request, env, request.method === 'GET' && !session);
    if (session) response.headers.set('x-doctorcre-partner-sign-in', 'engine');
    return response;
  }

  if (pathname === '/pipeline/changes') {
    if (engineSignIn(env)) {
      url.pathname = '/api/engine/pipeline/changes';
      return engineFetch(new Request(url, request), env).catch(() => json({ error: 'engine_unavailable' }, 503));
    }
    if (await switchedOn(env, DEALS))
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  }
  if (pathname === '/api/v1/business/leases') return json({ error: 'not_found' }, 404);
  if (PROXY_EXACT.has(pathname) || PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    const call = await mcpCall(request, url);
    if (call?.method === 'tools/call') {
      const { verb, args } = effectiveMcpVerb(call.params);
      if (RETIRED_MCP_TOOLS.has(verb) && !isCalendarAnswer(verb, args))
        return json({ error: 'not_found' }, 404);
    }
    const engine = await engineSave(request, env, call) ?? await engineResponse(request, env, call);
    if (engine) return engine;
    if (call?.method === 'tools/call' && call.params?.name === 'find-and-catch-up' && isObject(call.params.arguments) && Object.hasOwn(call.params.arguments, 'ref')) {
      delete call.params.arguments.ref;
      request = new Request(request, { body: JSON.stringify(call) });
    }
    const refusal = await refuseLegacyRequest(request, env, url, call);
    if (refusal) return refusal;
    if (/^\/api\/tours\/(?:projection|share|pdf|feedback)(?:\/|$)/.test(pathname)) return json({ error: 'not_found' }, 404);
    const legacy = await carrResponse(request, env);
    return call?.method === 'tools/call' && call.params?.name === 'record-commission-receipt'
      ? legacyInvoiceReceipt(legacy) : legacy;
  }
  return json({ error: "not_found" }, 404);
}

export async function handleDoctorcreRequest(request, env) {
  let response;
  try {
    response = clearInactiveSignInCookies(request, await handleRequest(request, env), env);
  } catch { response = json({ error: 'internal_error' }, 500); }
  return stampVersion(response, env);
}

// Open tabs read this through Resource Timing, so noticing a release costs no request.
function stampVersion(response, env) {
  const version = env?.CF_VERSION_METADATA?.id;
  if (!version) return response;
  const stamped = new Response(response.body, response);
  stamped.headers.append('server-timing', `version;desc="${version}"`);
  return stamped;
}

export default { fetch: handleDoctorcreRequest };
