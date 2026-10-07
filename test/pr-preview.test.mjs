import assert from 'node:assert/strict';
import test from 'node:test';
import preview from '../src/preview-worker.js';
import { resolveDealroomBoot } from '../js/boot-mode.js';

const origin = 'https://pr-123-doctorcre-app-pr-123.example.workers.dev';
const env = {
  PREVIEW_EXPIRES_AT: '2099-01-01T00:00:00.000Z', GIT_SHA: 'a'.repeat(40),
  ASSETS: { fetch: async request => new Response(new URL(request.url).pathname, {
    headers: { 'content-type': 'text/html' },
  }) },
  CARR: { fetch: () => { throw Error('preview reached production'); } },
};

test('a PR preview serves the app with its existing synthetic fixture client', async () => {
  const response = await preview.fetch(new Request(`${origin}/?mode=live`), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '/workspace.html');
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'(?:;|$)/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /127\.0\.0\.1/);
  assert.equal(resolveDealroomBoot(new URL(`${origin}/?mode=live`)).mode, 'fixture');
  const release = await (await preview.fetch(new Request(`${origin}/app-release`), env)).json();
  assert.equal(release.environment, 'preview');
  assert.equal(release.source_commit, 'a'.repeat(40));
});

test('all production interfaces refuse reads and writes, even with a CARR binding supplied', async () => {
  for (const path of ['/mcp', '/api/v1/business/clients', '/api/room/jobs', '/api/system-work/session', '/auth/login', '/pipeline/changes', '/share']) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await preview.fetch(new Request(`${origin}${path}`, { method }), env);
      assert.equal(response.status, 403, `${method} ${path}`);
    }
  }
});

test('expired or missing leases refuse every preview route', async () => {
  for (const PREVIEW_EXPIRES_AT of [undefined, 'invalid', '2000-01-01T00:00:00.000Z']) {
    for (const path of ['/', '/js/client.js', '/app-release', '/artifact-manifest.json']) {
      const response = await preview.fetch(new Request(`${origin}${path}`), { ...env, PREVIEW_EXPIRES_AT });
      assert.equal(response.status, 410);
    }
  }
});

test('the hosted journey oracle can read the deterministic build manifest', async () => {
  const response = await preview.fetch(new Request(`${origin}/artifact-manifest.json`), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '/artifact-manifest.json');
});
