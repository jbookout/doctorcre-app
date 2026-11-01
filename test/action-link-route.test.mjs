import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDoctorcreRequest } from '../src/worker.js';

const path = '/a/al1_bGQ6MTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTEx';
test('action links use the Leads gate and retain their exact sign-in destination', async () => {
  for (const status of [200, 302, 403, 503]) {
    let gatePath, asset;
    const response = await handleDoctorcreRequest(new Request(`https://app.doctorcre.com${path}`), {
      CARR: { fetch: async request => {
        gatePath = new URL(request.url).pathname;
        return new Response(null, {status, headers: status === 302 ? {location:'/auth/login?return_to=%2Fleads'} : {}});
      } },
      ASSETS: { fetch: async request => { asset = new URL(request.url).pathname; return new Response('page'); } },
    });
    assert.equal(gatePath, '/leads');
    assert.equal(response.status, status);
    assert.equal(asset, status === 200 ? '/action-link.html' : undefined);
    if (status === 302) assert.equal(new URL(response.headers.get('location')).searchParams.get('return_to'), path);
  }
});

test('linked drafts keep Leads selected in the shared navigation', async () => {
  const { activeDestination } = await import('../js/navigation.js');
  assert.equal(activeDestination(path), '/leads');
});
