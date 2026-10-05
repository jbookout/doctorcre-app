import test from 'node:test';
import assert from 'node:assert/strict';
import { installErrorTracking, createErrorBoundary } from '../js/error-tracking.js';
import { handleDoctorcreRequest } from '../src/worker.js';

test('browser onerror and unhandledrejection send scrubbed evidence and preserve prior handlers', async () => {
  const sent = []; let prior = 0;
  const host = { location: { pathname: '/clients/Alice' }, onerror: () => { prior++; return true; }, fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true }; } };
  const stop = installErrorTracking(host, 'a'.repeat(40));
  const error = new TypeError('Cannot read properties of Alice alice@example.test diagnosis');
  error.stack = 'TypeError: Alice\n at Alice (https://app/js/client.js?email=alice@example.test:12:3)';
  assert.equal(host.onerror(error.message, 'private', 12, 3, error), true);
  host.onunhandledrejection({ reason: error });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prior, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, 'TypeError');
  assert.equal(sent[0].route, '/clients/:value');
  assert.equal(sent[0].stack, 'asset:12:3');
  assert.equal(sent[0].release_sha, 'a'.repeat(40));
  assert.doesNotMatch(JSON.stringify(sent), /Alice|example|diagnosis|private/);
  stop();
  assert.equal(host.onunhandledrejection, undefined);
});

test('React boundary reports render failures and returns its supplied fallback', () => {
  class Component { constructor(props) { this.props = props; } }
  const reports = [];
  const Boundary = createErrorBoundary({ Component }, error => reports.push(error));
  const boundary = new Boundary({ children: 'content', fallback: 'recover' });
  assert.equal(boundary.render(), 'content');
  boundary.state = Boundary.getDerivedStateFromError();
  const error = new Error('private');
  boundary.componentDidCatch(error, { componentStack: 'private tree' });
  assert.equal(boundary.render(), 'recover');
  assert.deepEqual(reports, [error]);
});

test('app Worker captures asset exceptions and 5xx through the credentialless service seam', async () => {
  for (const kind of ['throw', '5xx']) {
    const events = [], waits = [];
    const env = { GIT_SHA: 'b'.repeat(40), CARR_ERRORS: { capture: async input => events.push(input) },
      ASSETS: { fetch: async () => { if (kind === 'throw') throw new TypeError('Alice alice@example.test'); return new Response('private', { status: 503 }); } } };
    const response = await handleDoctorcreRequest(new Request('https://app/js/private.js?email=alice@example.test'), env, { waitUntil: promise => waits.push(promise) });
    await Promise.all(waits);
    assert.equal(response.status, kind === 'throw' ? 500 : 503);
    assert.equal(events.length, 1);
    assert.equal(events[0].release_sha, 'b'.repeat(40));
    assert.doesNotMatch(JSON.stringify(events), /Alice|example|private/);
  }
});
