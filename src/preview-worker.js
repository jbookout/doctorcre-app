import { handleDoctorcreRequest } from './worker.js';
import { routeContract } from '../js/routes.js';

// Fixture-only PR preview. The browser already selects the in-memory fixture
// adapter on unreviewed hosts, so the app needs no backend here. The CARR page
// gate is answered locally for page routes and refuses everything else; no
// CARR service, database, secret or production route is bound to this Worker.
const pageGates = new Set([...Object.keys(routeContract.routes), ...Object.values(routeContract.gatePaths)]);
const refused = () => new Response(JSON.stringify({ error: 'preview_fixture_only' }), {
  status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const response = await handleDoctorcreRequest(request, {
      ASSETS: env.ASSETS, GIT_SHA: env.GIT_SHA, CF_VERSION_METADATA: env.CF_VERSION_METADATA, APP_ENV: 'preview',
      CARR: { fetch: async gate => pageGates.has(new URL(gate.url).pathname)
        && ['GET', 'HEAD'].includes(gate.method) ? new Response('') : refused() },
    });
    // The production shell may contact a local call controller that writes
    // records; a fixture preview must not reach it.
    const headers = new Headers(response.headers);
    const policy = headers.get('content-security-policy');
    if (policy) headers.set('content-security-policy', policy.replace(/connect-src[^;]*/, "connect-src 'self'"));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
