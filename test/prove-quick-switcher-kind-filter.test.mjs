import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const snapshot = await proofAssetSnapshot();
import { prove } from '../scripts/prove-quick-switcher-kind-filter.mjs';
function cli(origin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/prove-quick-switcher-kind-filter.mjs', '--origin', origin, '--timeout-ms', '5000']);
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value);
    child.stderr.on('data', value => stderr += value);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
async function fixture(t, fail = false) {
  const routes=new Map(snapshot);
  routes.set('/app-release',{contentType:'application/json',body:JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:'1'.repeat(40)})});
  if(fail)routes.set('/js/ui-quick-switcher.generated.js',{contentType:'text/javascript',body:'export function openQuickSwitcher() { throw Error("Broken deployed fixture"); }'});
  const server=await startFixture({routes});
  t.after(()=>server.close());
  return server.origin;
}
test('CLI passing fixture proves module only and failing fixture fails assertions', async t => {
  const passing = await cli(await fixture(t));
  assert.equal(passing.code, 78, passing.stdout + passing.stderr);
  const receipt = JSON.parse(passing.stdout);
  assert.equal(receipt.deployed_module, 'pass');
  assert.equal(receipt.natural_acceptance, 'insufficient_evidence');
  assert.equal(receipt.fixture_assertions.business_reads, 1);
  const failing = await cli(await fixture(t, true));
  assert.equal(failing.code, 1, failing.stdout + failing.stderr);
  assert.match(JSON.parse(failing.stdout).error, /Broken deployed fixture/);
});
for (const mode of ['late launch', 'stalled evaluation']) test(`deadline disposes ${mode} without retained browser handles`, async t => {
  const origin = new URL(await fixture(t));
  let open = 0;
  const engine = { launch: async () => {
    if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 150));
    open++;
    let closed = false;
    return { close: async () => { if (!closed) { closed = true; open--; } }, newContext: async () => ({
      setDefaultTimeout() {}, route: async () => {}, newPage: async () => ({ goto: async () => {}, evaluate: () => new Promise(() => {}) }),
    }) };
  } };
  const result = await prove({ origin, timeout: 75, engine });
  assert.equal(result.code, 78);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(open, 0);
});
test('deadline before launch refuses without waiting for an acquisition', async t => {
  const server = await startFixture({ routes: new Map([
    ['/app-release', { contentType: 'application/json', body: '{}', hold: 'release' }],
  ]) });
  t.after(() => server.close());
  let launches = 0;
  const result = await prove({ origin: new URL(server.origin), timeout: 75,
    engine: { launch: async () => { launches++; throw Error('Unexpected launch'); } } });
  assert.equal(result.code, 78);
  assert.equal(result.receipt.deployed_module, 'unverified');
  assert.equal(launches, 0);
});
for (const mode of ['late launch', 'stalled evaluation']) test(`real browser closes after ${mode}`, async t => {
  const { chromium } = await import('playwright');
  const { CHROMIUM_SAFETY_ARGS } = await import('../scripts/chromium-safety-args.mjs');
  const origin = new URL(await fixture(t));
  const acquired = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  const disconnected = new Promise(resolve => acquired.once('disconnected', resolve));
  const reached = Promise.withResolvers();
  const launch = Promise.withResolvers();
  const engine = { launch: async () => {
    if (mode === 'late launch') {
      reached.resolve();
      await launch.promise;
    } else {
      const newContext = acquired.newContext.bind(acquired);
      acquired.newContext = async options => {
        const context = await newContext(options);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          page.evaluate = () => { reached.resolve(); return new Promise(() => {}); };
          return page;
        };
        return context;
      };
    }
    return acquired;
  } };
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(AbortSignal, 'timeout', () => t.signal);
    const pending = prove({ origin, timeout: 200, engine });
    await Promise.race([reached.promise, pending.then(result => {
      assert.fail(`Proof finished before ${mode}: ${JSON.stringify(result.receipt)}`);
    })]);
    assert.equal(acquired.isConnected(), true);
    t.mock.timers.tick(200);
    const result = await pending;
    assert.equal(result.code, 78);
    t.mock.timers.reset();
    launch.resolve();
    await disconnected;
    assert.equal(acquired.isConnected(), false);
  } finally {
    t.mock.timers.reset();
    launch.resolve();
    await acquired.close();
  }
});
