import { handleDoctorcreRequest } from './worker.js';
import routes from '../contracts/app-routes.v1.json' with { type: 'json' };

// Browser boot on unreviewed hosts already selects the in-memory fixture
// adapter. Only the page gate is synthetic here; no CARR binding is forwarded.
const pageGates = new Set([...Object.keys(routes.routes), ...Object.values(routes.gatePaths)]);
const refused = () => new Response(JSON.stringify({ error: 'preview_fixture_only' }), {
  status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const expires = Date.parse(env.PREVIEW_EXPIRES_AT);
    if (!Number.isFinite(expires) || Date.now() >= expires) return new Response('PR preview expired', {
      status: 410, headers: { 'cache-control': 'no-store' },
    });
    const path = new URL(request.url).pathname;
    if (path === '/share') return refused();
    if (path === '/artifact-manifest.json' && ['GET', 'HEAD'].includes(request.method)) {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('cache-control', 'no-store');
      return new Response(response.body, { status: response.status, headers });
    }
    const response = await handleDoctorcreRequest(request, {
      ASSETS: env.ASSETS, GIT_SHA: env.GIT_SHA,
      CF_VERSION_METADATA: env.CF_VERSION_METADATA, APP_ENV: 'preview',
      CARR: { fetch: async gate => pageGates.has(new URL(gate.url).pathname)
        && ['GET', 'HEAD'].includes(gate.method) ? new Response('') : refused() },
    });
    // The production shell can contact a local call controller that writes
    // records. Fixture previews must not reach that controller either.
    const headers = new Headers(response.headers);
    const policy = headers.get('content-security-policy');
    if (policy) headers.set('content-security-policy', policy.replace(/connect-src[^;]*/, "connect-src 'self'"));
    return new Response(response.body, { status: response.status, headers });
  },
};
