import assert from 'node:assert/strict';
import test from 'node:test';
import { previewPlan, ensurePreviewWorker, deletePreviewWorker } from '../scripts/pr-preview.mjs';

test('the upload plan is bound to one PR and contains no production resources', () => {
  const plan = previewPlan(123, 'a'.repeat(40), new Date('2026-10-05T12:00:00Z'));
  assert.equal(plan.name, 'doctorcre-app-pr-123');
  assert.equal(plan.alias, 'pr-123');
  assert.equal(plan.config.vars.PREVIEW_EXPIRES_AT, '2026-10-12T12:00:00.000Z');
  assert.equal(plan.config.workers_dev, false);
  assert.equal(plan.config.preview_urls, true);
  assert.deepEqual(plan.config.routes, []);
  assert.equal(plan.config.services, undefined);
  assert.deepEqual(plan.upload.slice(0, 2), ['versions', 'upload']);
  assert.ok(plan.upload.includes('--preview-alias'));
  for (const pr of [0, -1, '123;exit', 'doctorcre-app']) assert.throws(() => previewPlan(pr, 'a'.repeat(40)));
});

test('first upload creates an undeployed preview-only Worker; updates never promote a version', async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    return new Response(JSON.stringify({ success: true, result: {} }), { status: calls.length === 1 ? 404 : 200 });
  };
  await ensurePreviewWorker(123, api);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(calls[1].body, { name: 'doctorcre-app-pr-123', subdomain: { enabled: false, previews_enabled: true } });
  calls.length = 0;
  await ensurePreviewWorker(123, async (path, options) => {
    calls.push({ path, options });
    return new Response(JSON.stringify({ success: true, result: { name: 'doctorcre-app-pr-123' } }));
  });
  assert.equal(calls.length, 1);
});

test('closing a PR deletes only its isolated Worker and tolerates an already missing Worker', async () => {
  for (const status of [200, 404]) {
    const calls = [];
    await deletePreviewWorker(123, async (path, options) => {
      calls.push({ path, ...options });
      return new Response(JSON.stringify({ success: status === 200 }), { status });
    });
    assert.deepEqual(calls, [{ path: '/workers/scripts/doctorcre-app-pr-123', method: 'DELETE' }]);
  }
  await assert.rejects(deletePreviewWorker(123, async () => new Response('{}', { status: 403 })), /Cloudflare.*403/);
});
