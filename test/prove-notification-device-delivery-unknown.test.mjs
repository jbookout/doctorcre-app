import test from 'node:test';
import { chromium, fixtureServer } from './browser-harness.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { readAppRelease } from '../scripts/app-release-reader.mjs';
import { observeDelivery } from '../scripts/prove-notification-device-delivery-unknown.mjs';
import { createFixtureClient } from '../js/fixture-client.js';
import * as model from '../js/notifications-model.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const baseline = execFileSync('git', ['show', '5b6d1a76493913da5173513c9c129c3c3648ab68:js/notifications-model.js']);
async function fixture(t, mode) {
  const seen = [], served = new Map();
  let identities = 0;
  const server = createServer(async (req, res) => {
    seen.push({ method: req.method, path: req.url });
    let path;
    try { path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0])); } catch { res.writeHead(400); return res.end(); }
    if (!path.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    if (mode === 'timeout') return;
    if (req.url === '/app-release') {
      const identity = { service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) };
      if (mode === 'release-change' && ++identities > 1) identity.source_commit = '2'.repeat(40);
      const body = JSON.stringify(mode === 'identity' ? {} : identity);
      res.setHeader('content-type', 'application/json');
      return res.end(body);
    }
    if (mode === 'missing-asset') { res.writeHead(404); return res.end(); }
    if (mode === 'protected') { res.writeHead(302, { location: '/sign-in' }); return res.end(); }
    try {
      if (!req.url.startsWith('/js/') || !/\.(js|mjs)$/.test(path)) throw Error('Unexpected asset');
      let body = mode === 'cap' && /proof-cap-/.test(path) ? Buffer.from('export const x = 1;') : await readFile(path);
      if (req.url === '/js/notifications-model.js') {
        if (mode === 'baseline') body = baseline;
        if (mode === 'network') body = Buffer.from('await fetch("/api/business");');
        if (mode === 'cap') body = Buffer.from(Array.from({ length: 21 }, (_, i) => `import "./proof-cap-${i}.js";`).join('\n'));
      }
      if (mode === 'cap' && /proof-cap-/.test(path)) body = Buffer.from('export const x = 1;');
      served.set(req.url, createHash('sha256').update(body).digest('hex'));
      res.setHeader('content-type', 'text/javascript');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, served };
}
async function cli(origin, timeout = '30000', extra = []) {
  const child = spawn(process.execPath, ['scripts/prove-notification-device-delivery-unknown.mjs', '--origin', origin, '--timeout-ms', timeout, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { code, receipt: JSON.parse(stdout.trim()), stderr };
}

test('proof CLI executes deployed module graph and binds exact hashes and Worker identity', async t => {
  const f = await fixture(t);
  const { code, receipt } = await cli(f.origin);
  assert.equal(code, 0, JSON.stringify(receipt));
  assert.equal(receipt.schema, 'notification-device-delivery-unknown-proof.v1');
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.assertions.length, observeDelivery(model).assertions.length);
  assert.ok(receipt.assets.length > 1 && receipt.assets.length <= 20);
  for (const asset of receipt.assets) assert.equal(asset.sha256, f.served.get(new URL(asset.url).pathname));
  assert.deepEqual(receipt.release, await readAppRelease(f.origin, async () => ({ type: 'application/json', body: Buffer.from(JSON.stringify(receipt.release)) })));
  assert.equal(f.seen.filter(req => req.path === '/app-release').length, 2);
  assert.ok(f.seen.every(req => req.method === 'GET'));
  console.log(JSON.stringify({ case: 'pass', code, receipt }));
});
for (const [mode, expected] of [['baseline', 1], ['protected', 78], ['missing-asset', 78], ['identity', 78], ['timeout', 78], ['release-change', 1], ['network', 1], ['cap', 78]]) {
  test(`proof CLI refuses ${mode} with the same origin and timeout flags`, async t => {
    const f = await fixture(t, mode);
    const { code, receipt } = await cli(f.origin);
    assert.equal(code, expected, JSON.stringify(receipt));
    assert.notEqual(receipt.status, 'passed');
    assert.ok(!f.seen.some(req => req.path.startsWith('/api/') || req.path === '/sign-in'));
    console.log(JSON.stringify({ case: mode, code, receipt }));
  });
}
test('proof CLI validates flags and the requirement pins the command', async t => {
  const f = await fixture(t);
  for (const [origin, timeout, extra] of [[f.origin, '0', []], [f.origin, '30001', []], [`${f.origin}/path`, '30000', []], [f.origin, '30000', ['--unexpected']]]) {
    assert.equal((await cli(origin, timeout, extra)).code, 1);
  }
  const plan = JSON.parse(await readFile(new URL('../proofs/requirements/notification-device-delivery-unknown.json', import.meta.url)));
  assert.ok(plan.assertions[0].predicate.includes('node scripts/prove-notification-device-delivery-unknown.mjs --origin https://app.doctorcre.com --timeout-ms 30000'));
  assert.equal(plan.safety.max_requests, 22);
});
test('proof synthetic notification matches existing producer fixture and production parser', async () => {
  const seed = await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8');
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString('base64')}` });
  const feed = await client.notificationFeed({ limit: 25 });
  assert.equal(model.validFeedPayload(feed), true);
  const row = feed.notifications.find(row => row.id.endsWith('1103'));
  assert.equal(model.notificationCards(feed).find(card => card.id === row.id).read, true);
  assert.deepEqual(row.delivery, [{ channel: 'in_app', state: 'delivered' }, { channel: 'device', state: 'delivered' }]);
  const observed = [];
  const result = observeDelivery({ ...model, notificationCards: payload => {
    assert.equal(model.validFeedPayload(payload), true);
    observed.push(payload);
    return model.notificationCards(payload);
  } });
  assert.deepEqual(observed.find(payload => payload.notifications[0].delivery?.[1]?.state === 'delivered').notifications[0], row);
  assert.ok(result.assertions.includes('producer-delivery-contract'));
});

for (const width of [390, 1440]) {
  test(`device delivery unavailable renders in Updates and keeps keyboard refresh at ${width}px`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const seed = JSON.parse(await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8'));
    seed.notifications[0].delivery = [{ channel: 'in_app', state: 'delivered' }, { channel: 'device', state: null }];
    await page.route('**/data/board-seed.json', route => route.fulfill({ json: seed }));
    await page.goto(`${server.origin}/updates?mode=fixture`);
    const row = page.locator(`[data-notification="${seed.notifications[0].id}"]`);
    await row.locator('[data-channel="device"]').waitFor();
    assert.equal(await row.locator('[data-channel="device"]').textContent(), 'Delivery status unavailable');
    assert.equal(await row.locator('[data-channel="in_app"]').textContent(), 'delivered');
    assert.equal(await row.locator('[data-ack]').count(), 1);
    await page.getByRole('button', { name: 'Refresh', exact: true }).focus();
    await page.keyboard.press('Enter');
    await row.locator('[data-channel="device"]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'retryRead');
    assert.equal(await row.locator('[data-channel="device"]').textContent(), 'Delivery status unavailable');
  });
}
