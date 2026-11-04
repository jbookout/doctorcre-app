import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const compiled = await build({ entryPoints: ['src/ui/web-push-client.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { createWebPush, browserPush } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
function fixture(options = {}) {
  let tick = 0, permission = options.permission || 'granted', local = null, receipt = null, enabled = false, version = 1;
  const values = new Map(), calls = [], storage = { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  const sub = endpoint => ({ endpoint, keys: { p256dh: 'synthetic-public', auth: 'synthetic-auth' } });
  const browser = {
    capability: () => options.capability || 'supported', permission: () => permission,
    async requestPermission() { calls.push(['permission']); permission = options.answer || 'granted'; return permission; },
    async subscription() { return local; }, async subscribe(key) { calls.push(['subscribe', key]); local = sub('https://push.example/a'); return local; },
    async unsubscribe() { calls.push(['unsubscribe']); local = null; },
  };
  const transport = {
    async config() { calls.push(['config']); return { public_key: 'synthetic-key', generation: 'fixture-1' }; },
    async read(id) { calls.push(['read', id]); return { receipt, preference: { version, device_opt_in: enabled } }; },
    async register(request) { calls.push(['register', structuredClone(request)]); receipt = { actor: 'synthetic', installation_id: request.installation_id, endpoint: request.subscription.endpoint, status: 'active' }; if (options.registerFails) throw Error('unknown'); return receipt; },
    async preference(request) { calls.push(['preference', request]); if (options.preferenceFails) throw Object.assign(Error('failed'), { code: options.preferenceFails }); assert.equal(request.base_version, version); version++; enabled = request.device_opt_in; },
    async revoke(request) { calls.push(['revoke', structuredClone(request)]); if (options.revokeFails) throw Error('unknown'); receipt = null; },
  };
  const args = { actor: 'synthetic', session: 'session-a', browser, transport, storage, uuid: () => `synthetic-${++tick}`, now: () => tick * 1000 };
  const client = createWebPush(args);
  return { client, calls, values, options, args, sub, rotate() { local = sub('https://push.example/b'); }, disableServer() { enabled = false; version++; }, count: name => calls.filter(c => c[0] === name).length };
}
test('no_permission_request_on_page_load', async () => { const f = fixture({ permission: 'default' }); await f.client.reconcile(); assert.equal(f.client.state.kind, 'permission_default'); assert.equal(f.count('permission'), 0); });
test('permission_denial_never_reprompts', async () => { const f = fixture({ permission: 'default', answer: 'denied' }); await f.client.enable(); await f.client.enable(); assert.equal(f.client.state.kind, 'permission_denied'); assert.equal(f.count('permission'), 1); assert.equal(f.count('register'), 0); });
for (const [capability, state] of [['unsupported','unsupported'], ['not_installed','not_installed']]) test(`${state}_guidance`, async () => { const f = fixture({ capability }); await f.client.reconcile(); await f.client.enable(); assert.equal(f.client.state.kind, state); assert.equal(f.calls.length, 0); });
test('browser_state_matches_server_receipt', async () => { const f = fixture(); await f.client.enable(); assert.equal(f.client.state.kind, 'subscribed'); f.rotate(); await f.client.reconcile(true); assert.equal(f.client.state.kind, 'revoked'); await f.client.enable(); assert.equal(f.client.state.kind, 'subscribed'); assert.equal(f.count('register'), 2); });
test('setup_request_count_bounded', async () => { const f = fixture(); await f.client.reconcile(); assert.equal(f.count('config'), 1); assert.equal(f.count('read'), 1); assert.equal(f.count('register'), 0); });
test('repeated_resume_does_not_reregister', async () => { const f = fixture(); await f.client.enable(); await f.client.reconcile(); await f.client.reconcile(); await f.client.reconcile(); assert.equal(f.count('register'), 1); assert.equal(f.count('read'), 3); });
test('disabled_preference_overrides_local_subscription', async () => { const f = fixture(); await f.client.enable(); f.disableServer(); await f.client.reconcile(true); assert.equal(f.client.state.kind, 'preference_disabled'); });
test('partial_success_reconcile', async () => { const f = fixture({ preferenceFails: 'network' }); await f.client.enable(); assert.equal(f.client.state.kind, 'preference_disabled'); f.options.preferenceFails = false; await f.client.reconcile(true); assert.equal(f.client.state.kind, 'preference_disabled'); await f.client.enable(); assert.equal(f.client.state.kind, 'subscribed'); assert.equal(f.count('register'), 1); });
test('cas_conflict_zero_automatic_retry', async () => { const f = fixture({ preferenceFails: 'version_conflict' }); await f.client.enable(); assert.equal(f.client.state.kind, 'preference_disabled'); assert.match(f.client.state.message, /changed elsewhere/); assert.equal(f.count('preference'), 1); });
test('registration_failure_truthful', async () => { const f = fixture({ registerFails: true }); await f.client.enable(); assert.equal(f.client.state.kind, 'unavailable'); assert.equal(f.count('preference'), 0); });
test('failure_does_not_loop', async () => { const f = fixture({ registerFails: true }); await f.client.enable(); await f.client.reconcile(); await f.client.reconcile(); assert.equal(f.count('register'), 1); });
test('double_click_single_registration', async () => { const f = fixture(); await Promise.all([f.client.enable(), f.client.enable()]); assert.equal(f.count('register'), 1); assert.equal(f.count('preference'), 1); });
test('unknown_result_reuses_key', async () => { const f = fixture({ registerFails: true }); await f.client.enable(); const next = createWebPush(f.args); f.options.registerFails = false; await next.enable(); const registers = f.calls.filter(c => c[0] === 'register'); assert.deepEqual(registers[0][1], registers[1][1]); });
test('opt_out_failure_recovery', async () => { const f = fixture({ revokeFails: true }); await f.client.enable(); await f.client.disable(); assert.equal(f.client.state.kind, 'preference_disabled'); assert.match(f.client.state.message, /cleanup failed/); assert.equal(f.calls.findLast(c => c[0] === 'preference')[1].device_opt_in, false); f.options.revokeFails = false; await f.client.disable(); assert.deepEqual(f.calls.filter(c => c[0] === 'revoke').map(c => c[1]), [f.calls.find(c => c[0] === 'revoke')[1], f.calls.find(c => c[0] === 'revoke')[1]]); assert.equal(f.count('unsubscribe'), 1); });
test('logout_clears_installation_binding', async () => { const f = fixture(); await f.client.enable(); assert.equal(f.values.size, 1); f.client.logout(); assert.equal(f.values.size, 0); await f.client.enable(); assert.equal(f.count('register'), 1); assert.equal(f.client.state.kind, 'revoked'); });
test('no_interval_added', async () => { const source = await readFile('src/ui/web-push-settings.tsx', 'utf8'); assert.doesNotMatch(source, /setInterval/); });
const inboxBuild = await build({ entryPoints: ['src/ui/home/inbox.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { createInboxClient } = await import(`data:text/javascript;base64,${Buffer.from(inboxBuild.outputFiles[0].contents).toString('base64')}`);
test('out_of_page_card_uses_single_card_read_and_rejects_wrong_identity', async () => {
  const events = [];
  const client = createInboxClient(async () => { throw Error('No generic lookup'); }, async (event_id) => { events.push(event_id); return { ok: true, item: { item_id: 'wrong' } }; });
  await assert.rejects(() => client.readCard('encoded:card/1'), /unavailable|identity|unreadable/i);
  assert.deepEqual(events, ['encoded:card/1']);
});
test('expired_target_is_explained', async () => {
  const client = createInboxClient(async () => null, async () => ({ ok: true, item: null }));
  assert.equal(await client.readCard('expired'), null);
});

import { before, after } from 'node:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium, fixtureServer } from './browser-harness.mjs';
let outDir;
before(async () => { outDir = await temporaryDirectory('doctorcre-web-push-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });
async function open(t) {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  return { page, server };
}
test('rendered_enable_disable_preference_and_logout', async t => {
  const { page, server } = await open(t); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${server.origin}/notifications`);
  const settings = page.locator('#webPushSettings');
  await settings.locator('[data-push-state="permission_default"]').waitFor();
  assert.equal(await page.locator('#deviceOptIn').isDisabled(), true);
  await settings.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await settings.locator('[data-push-state="subscribed"]').waitFor();
  await settings.getByRole('button', { name: 'Disable notifications', exact: true }).click();
  await settings.locator('[data-push-state="preference_disabled"]').waitFor();
  await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
  await settings.locator('[data-push-state="revoked"]').waitFor();
  assert.equal(await settings.getByRole('button', { name: 'Enable notifications', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
});
test('out_of_page_card_renders_exact_identity_and_expired_target_explained', async t => {
  const { page, server } = await open(t);
  await page.goto(`${server.origin}/inbox/card/${encodeURIComponent('synthetic:outside/card')}`);
  await page.locator('[data-current="true"]').waitFor();
  assert.equal(await page.locator('[data-current="true"]').getAttribute('data-inbox-row'), 'synthetic:outside/card');
  assert.match(await page.locator('[data-current="true"]').textContent(), /Synthetic out-of-page review/);
  await page.goto(`${server.origin}/inbox/card/expired`);
  await page.getByText('This card has expired or is no longer available to you.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-current="true"]').count(), 0);
});
test('denied_permission_stays_distinct_when_transport_is_unavailable', async () => {
  const f = fixture({ permission: 'denied' }); f.args.transport.config = async () => { throw Error('offline'); };
  await f.client.reconcile(); assert.equal(f.client.state.kind, 'permission_denied'); assert.equal(f.count('permission'), 0);
});
test('opt_out_preference_failure_never_revokes_browser', async () => {
  const f = fixture(); await f.client.enable(); f.options.preferenceFails = 'version_conflict';
  await f.client.disable(); assert.equal(f.count('revoke'), 0); assert.equal(f.count('unsubscribe'), 0); assert.notEqual(f.client.state.kind, 'subscribed');
});
function browserGlobals(t, overrides = {}) {
  for (const [key, value] of Object.entries({ isSecureContext: true, navigator: { userAgent: 'Synthetic Chromium', platform: 'MacIntel', maxTouchPoints: 0, serviceWorker: {} }, Notification: { permission: 'default' }, PushManager: class {}, matchMedia: () => ({ matches: false }), ...overrides })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (prior) Object.defineProperty(globalThis, key, prior); else delete globalThis[key]; });
  }
}
test('ios_install_guidance_and_actual_browser_unsupported', t => {
  browserGlobals(t); assert.equal(browserPush().capability(), 'supported');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 } });
  assert.equal(browserPush().capability(), 'not_installed');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Synthetic', platform: 'Synthetic', maxTouchPoints: 0 } });
  assert.equal(browserPush().capability(), 'unsupported');
});
test('browser_adapter_registers_with_public_vapid_key', async t => {
  let received; const registrations = [];
  const sub = { toJSON: () => ({ endpoint: 'https://push.example/synthetic', keys: { p256dh: 'synthetic-public', auth: 'synthetic-auth' } }) };
  const registration = { pushManager: { subscribe: async options => { received = options; return sub; } } };
  browserGlobals(t, { navigator: { serviceWorker: { async register(path) { registrations.push(path); return registration; }, ready: Promise.resolve(registration) } } });
  const result = await browserPush().subscribe('AQIDBA');
  assert.deepEqual(registrations, ['/sw.js']); assert.equal(received.userVisibleOnly, true);
  assert.deepEqual([...received.applicationServerKey], [1, 2, 3, 4]); assert.equal(result.endpoint, 'https://push.example/synthetic');
});
