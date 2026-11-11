import test from 'node:test';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readAppRelease } from '../scripts/app-release-reader.mjs';
import { observeDelivery, observeOnPage } from '../scripts/prove-notification-device-delivery-unknown.mjs';
import { createFixtureClient } from '../js/fixture-client.js';
import * as model from '../js/notifications-model.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const modelSource = await readFile(resolve(root, 'js/notifications-model.js'), 'utf8');
const falseAbsenceSource = modelSource.replace(
  'const absent = Array.isArray(delivery) && rows.every(validRow);',
  'const absent = true;',
);
assert.notEqual(falseAbsenceSource, modelSource, 'Fixture must inject an unvalidated device-absence claim');
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const snapshot = await proofAssetSnapshot();
async function fixture(t, mode) {
  const routes = new Map(snapshot);
  routes.set('/fixture.html', {contentType:'text/html',body:'<!doctype html><title>Module observation</title>'});
  if (mode === 'missing-asset' || mode === 'protected') for (const path of routes.keys()) routes.set(path,
    mode === 'protected' ? {status:302,headers:{location:'/sign-in'}} : {status:404});
  const key = '/js/notifications-model.js';
  if (mode === 'false-absence' || mode === 'network' || mode === 'cap') routes.set(key, {contentType:'text/javascript',
    body:mode==='false-absence'?falseAbsenceSource:mode==='network'?'await fetch("/api/business");':Array.from({length:21},(_,i)=>`import "./proof-cap-${i}.js";`).join('\n')});
  if (mode === 'cap') for (let i=0;i<21;i++) routes.set(`/js/proof-cap-${i}.js`,{contentType:'text/javascript',body:'export const x = 1;'});
  const served = new Map([...routes].map(([path,response])=>[path,createHash('sha256').update(response.body || '').digest('hex')]));
  const identity = sha => ({contentType:'application/json',body:JSON.stringify(mode==='identity'?{}:{service:'doctorcre-app',environment:'production',source_commit:sha.repeat(40)})});
  routes.set('/app-release',{sequence:[identity('1'),identity(mode==='release-change'?'2':'1')]});
  if(mode==='timeout')routes.set('/app-release',{hold:'timeout'});
  const server=await startFixture({routes});
  t.after(()=>server.close());
  return {origin:server.origin,get seen(){return server.requests.map(req=>({method:req.method,path:req.target}));},served};
}
async function cli(origin, timeout = '30000', extra = []) {
  const child = spawn(process.execPath, ['scripts/prove-notification-device-delivery-unknown.mjs', '--origin', origin, '--timeout-ms', timeout, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { code, receipt: JSON.parse(stdout.trim()), stderr };
}

test('page observation passes hostile asset URLs as data instead of executable source', async () => {
  const assetUrl = 'https://example.invalid/js/notifications-model.js#</script>';
  const expected = { assertions: ['structured-argument'] };
  const result = await observeOnPage({ evaluate: async (observer, argument) => {
    assert.equal(typeof observer, 'function', 'Browser receives a function, never generated source');
    assert.equal(argument, assetUrl, 'Browser receives the unchanged URL as a separate argument');
    assert.ok(!observer.toString().includes(assetUrl));
    return expected;
  } }, assetUrl);
  assert.deepEqual(result, expected);
});

test('page observation imports a module with a hostile URL fragment', async t => {
  const f = await fixture(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(f.origin + '/fixture.html');
  const result = await observeOnPage(page, f.origin + '/js/notifications-model.js#</script>');
  assert.ok(result.assertions.includes('null-unavailable'));
  assert.ok(result.assertions.includes('empty-confirmed-absence'));
});

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
for (const [mode, expected] of [['false-absence', 1], ['protected', 78], ['missing-asset', 78], ['identity', 78], ['timeout', 78], ['release-change', 1], ['network', 1], ['cap', 78]]) {
  test(`proof CLI refuses ${mode} with the same origin and timeout flags`, async t => {
    const f = await fixture(t, mode);
    const { code, receipt } = await cli(f.origin);
    assert.equal(code, expected, JSON.stringify(receipt));
    assert.notEqual(receipt.status, 'passed');
    if (mode === 'false-absence') assert.match(receipt.error, /null-unavailable/);
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
