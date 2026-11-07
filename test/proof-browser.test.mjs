import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ownedBrowserProcesses } from './proof-browser-harness.mjs';
import { launchProofBrowser } from '../scripts/app-release-reader.mjs';
import { chromium, signedInEngine } from '../scripts/proof-browser.mjs';

const required = ['--use-mock-keychain', '--password-store=basic'];
async function stubLaunch(t, launch) {
  const { chromium: raw } = await import('playwright');
  t.mock.method(raw, 'launch', launch);
}

test('mandatory flags cannot be replaced; caller flags and environment survive', async t => {
  let seen;
  await stubLaunch(t, async options => { seen = options; return { close: async () => {} }; });
  const browser = await chromium.launch({ args: ['--password-store=gnome', '--use-mock-keychain=false', '--disable-gpu'], env: { PROOF_TEST: 'kept', TMPDIR: '/not-owned' }, timeout: 1234 });
  try {
    assert.deepEqual(seen.args, [...required, '--disable-gpu']);
    assert.equal(seen.timeout, 1234);
    assert.equal(seen.env.PROOF_TEST, 'kept');
    assert.notEqual(seen.env.TMPDIR, '/not-owned');
    assert.equal(seen.env.TMPDIR, seen.env.TEMP);
    assert.equal(seen.env.TMPDIR, seen.env.TMP);
    assert.ok(existsSync(seen.env.TMPDIR));
  } finally { await browser.close(); }
  assert.equal(existsSync(seen.env.TMPDIR), false);
});

test('reserved switch spelling table cannot override mandatory flags', async t => {
  let seen;
  await stubLaunch(t, async options => { seen = options.args; return { close: async () => {} }; });
  for (const name of ['password-store', 'use-mock-keychain']) {
    for (const spelling of [name, name.toUpperCase(), name.replace(/^./, c => c.toUpperCase())]) {
      for (const prefix of ['-', '--', '/']) {
        for (const value of ['', '=', '=gnome', '=false', '=GNOME', '=gnome=extra']) {
          for (const whitespace of ['', ...'\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000']) {
            const argument = `${whitespace}${prefix}${spelling}${value}${whitespace}`;
            const browser = await chromium.launch({ args: [argument, '--disable-gpu', '-unrelated=value', '--password-store-extra=kept'] });
            try {
              assert.deepEqual(seen, [...required, '--disable-gpu', '-unrelated=value', '--password-store-extra=kept'], JSON.stringify(argument));
            } finally { await browser.close(); }
          }
        }
      }
    }
  }
});

test('real Chromium cannot receive the single-dash password-store override', async () => {
  const browser = await chromium.launch({ args: ['--enable-automation', '-password-store=gnome', '--disable-gpu'] });
  try {
    const cdp = await browser.newBrowserCDPSession();
    const { arguments: args } = await cdp.send('Browser.getBrowserCommandLine');
    const stores = args.filter(arg => /^--?password-store(?:=|$)/.test(arg));
    assert.ok(stores.length > 0);
    assert.ok(stores.every(arg => arg === '--password-store=basic'), JSON.stringify(stores));
    assert.ok(args.includes('--use-mock-keychain'));
    assert.ok(args.includes('--disable-gpu'));
  } finally { await browser.close(); }
});

test('each launch owns a unique directory; close and double close dispose once', async t => {
  const roots = []; let closes = 0;
  await stubLaunch(t, async options => { roots.push(options.env.TMPDIR); return { close: async () => { closes++; }, newPage: async () => 'full API' }; });
  const first = await chromium.launch(), second = await chromium.launch();
  assert.notEqual(roots[0], roots[1]);
  assert.equal(await first.newPage(), 'full API');
  await Promise.all([first.close(), first.close()]);
  assert.equal(closes, 1);
  assert.equal(existsSync(roots[0]), false);
  assert.ok(existsSync(roots[1]));
  await second.close();
  assert.equal(existsSync(roots[1]), false);
});

test('launch rejection removes its directory and preserves the error', async t => {
  let root;
  const reason = Error('launch rejected');
  await stubLaunch(t, async options => { root = options.env.TMPDIR; throw reason; });
  await assert.rejects(chromium.launch(), error => error === reason);
  assert.equal(existsSync(root), false);
});

test('launch budget stays bounded even when callers request unlimited or excessive time', async t => {
  const budgets = [];
  await stubLaunch(t, async options => { budgets.push(options.timeout); return { close: async () => {} }; });
  for (const timeout of [undefined, 0, 90000]) await (await chromium.launch({ timeout })).close();
  assert.deepEqual(budgets, [30000, 30000, 30000]);
});

test('failed close reports failure and retains the directory until exit fallback', async t => {
  let root, closes = 0;
  const reason = Error('close failed');
  await stubLaunch(t, async options => { root = options.env.TMPDIR; return { close: async () => { closes++; throw reason; } }; });
  const browser = await chromium.launch();
  await assert.rejects(browser.close(), error => error === reason);
  await assert.rejects(browser.close(), error => error === reason);
  assert.equal(closes, 1);
  assert.ok(existsSync(root));
});

function assertNoOwnedProcesses(root, pids) {
  assert.ok(root);
  const survivors = [...new Set([...ownedBrowserProcesses(root), ...pids.filter(pid => {
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  })])];
  assert.deepEqual(survivors, [], 'zero surviving owned browser processes');
  assert.equal(existsSync(root), false);
}

for (const mode of ['success', 'rejection', 'abort', 'setup exception']) test(`real dedicated browser ${mode} disposes owned resources`, async t => {
  const { chromium: raw } = await import('playwright');
  const launch = raw.launch.bind(raw);
  let root;
  let pids = [];
  t.mock.method(raw, 'launch', options => { root = options.env.TMPDIR; return launch(options); });
  if (mode === 'rejection') {
    await assert.rejects(chromium.launch({ executablePath: '/nonexistent-proof-chromium' }));
  } else {
    const owner = new AbortController();
    const browser = await launchProofBrowser(chromium, { timeout: 10000 }, { signal: owner.signal });
    const observe = async () => {
      try {
        const page = await browser.newPage();
        pids = ownedBrowserProcesses(root, process.pid).filter(pid => pid !== process.pid);
        assert.ok(pids.length > 0);
        if (mode === 'success') assert.equal(await page.evaluate(() => 6 * 7), 42);
        if (mode === 'setup exception') throw Error('proof setup failed');
        if (mode === 'abort') {
          const pending = page.evaluate(() => new Promise(() => {}));
          owner.abort(Object.assign(Error('proof aborted'), { exitCode: 78 }));
          await assert.rejects(pending, { exitCode: 78 });
        }
      } finally { await browser.close(); }
    };
    if (mode === 'setup exception') await assert.rejects(observe(), /proof setup failed/);
    else await observe();
  }
  assertNoOwnedProcesses(root, pids);
});

test('borrowed acquisition rejection is insufficient evidence', async () => {
  await assert.rejects(chromium.connectOverCDP('http://127.0.0.1:1', { timeout: 100 }), { exitCode: 78 });
});

test('borrowed page rejection is insufficient evidence and close drains late pages', async t => {
  const { chromium: raw } = await import('playwright');
  let resolvePage, closed = 0, disconnected = 0;
  const page = { close: async () => { closed++; } };
  t.mock.method(raw, 'connectOverCDP', async () => ({ contexts: () => [{ newPage: () => new Promise(resolve => { resolvePage = resolve; }) }], close: async () => { disconnected++; } }));
  const borrowed = await chromium.connectOverCDP('http://127.0.0.1:1234');
  const pending = borrowed.newPage();
  await new Promise(resolve => setImmediate(resolve));
  const closing = borrowed.close();
  assert.equal(disconnected, 0);
  resolvePage(page);
  await assert.rejects(pending, { exitCode: 78 });
  await closing;
  assert.equal(closed, 1);
  assert.equal(disconnected, 1);
  await borrowed.close();
  assert.equal(disconnected, 1);
});

for (const late of [false, true]) test(`real CDP preserves borrowed browser and existing tabs${late ? ' after late page' : ''}`, async t => {
  const { startFixture } = await import('../scripts/fixture-http.mjs');
  const portFixture = await startFixture();
  const port = new URL(portFixture.origin).port;
  await portFixture.close();
  const owner = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const { chromium: raw } = await import('playwright');
  const connect = raw.connectOverCDP.bind(raw);
  const endpoint = `http://127.0.0.1:${port}`;
  let observer, borrowed;
  try {
    observer = await connect(endpoint);
    const existing = await observer.contexts()[0].newPage();
    await existing.goto('data:text/html,original');
    const before = observer.contexts()[0].pages().length;
    await observer.close(); observer = undefined;
    if (late) t.mock.method(raw, 'connectOverCDP', async (...args) => {
      const connection = await connect(...args);
      const context = connection.contexts()[0];
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        await new Promise(resolve => setTimeout(resolve, 150));
        return page;
      };
      return connection;
    });
    borrowed = await launchProofBrowser(signedInEngine(endpoint), { timeout: late ? 100 : 10000 });
    if (late) await assert.rejects(borrowed.newPage(), { exitCode: 78 });
    else {
      const timezoneId = 'America/Chicago';
      const context = await borrowed.newContext({ viewport: { width: 390, height: 844 }, timezoneId });
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: 'owned route' }));
      const page = await context.newPage();
      await page.goto('http://127.0.0.1:1/owned');
      assert.equal(await page.locator('body').textContent(), 'owned route');
      assert.deepEqual(page.viewportSize(), { width: 390, height: 844 });
      assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), timezoneId);
      await context.close();
      assert.equal(owner.isConnected(), true);
      await (await borrowed.newPage()).goto('data:text/html,owned');
    }
    await borrowed.close(); borrowed = undefined;
    observer = await connect(endpoint);
    assert.equal(observer.contexts()[0].pages().length, before, 'fresh connection counts zero added tabs');
    assert.ok(observer.contexts()[0].pages().some(page => page.url() === 'data:text/html,original'));
    assert.equal(owner.isConnected(), true);
  } finally { await borrowed?.close(); await observer?.close(); await owner.close(); }
});

test('real CDP blocks service workers only on owned proof pages', async () => {
  const { startFixture } = await import('../scripts/fixture-http.mjs');
  const fixture = await startFixture({ routes: new Map([
    ['/', { contentType: 'text/html', body: '<html>owned fixture</html>' }],
    ['/sw.js', { contentType: 'text/javascript', body: "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/data')e.respondWith(new Response('from-worker'));});" }],
    ['/data', { contentType: 'text/plain', body: 'from-network' }],
  ]) });
  const portFixture = await startFixture();
  const port = new URL(portFixture.origin).port;
  await portFixture.close();
  const owner = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const { chromium: raw } = await import('playwright');
  let observer, borrowed;
  const response = page => page.evaluate(async () => ({
    controlled: !!navigator.serviceWorker.controller,
    body: await (await fetch('/data')).text(),
  }));
  try {
    observer = await raw.connectOverCDP(`http://127.0.0.1:${port}`);
    const existing = await observer.contexts()[0].newPage();
    await existing.goto(fixture.origin);
    await existing.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    assert.deepEqual(await response(existing), { controlled: true, body: 'from-worker' });
    const launched = await owner.newPage({ serviceWorkers: 'block' });
    await launched.route('**/data', route => route.fulfill({ body: 'from-proof-route' }));
    await launched.goto(fixture.origin);
    assert.deepEqual(await response(launched), { controlled: false, body: 'from-proof-route' });
    await launched.close();
    borrowed = await signedInEngine(`http://127.0.0.1:${port}`).launch({ timeout: 5000 });
    for (const contextMode of [false, true]) {
      const context = contextMode ? await borrowed.newContext({ serviceWorkers: 'block' }) : borrowed;
      const page = await context.newPage(contextMode ? undefined : { serviceWorkers: 'block' });
      await page.route('**/data', route => route.fulfill({ body: 'from-proof-route' }));
      await page.goto(fixture.origin);
      assert.deepEqual(await response(page), { controlled: false, body: 'from-proof-route' });
      await page.close();
      assert.deepEqual(await response(existing), { controlled: true, body: 'from-worker' });
    }
    const allowed = await borrowed.newPage({ serviceWorkers: 'allow' });
    await allowed.goto(fixture.origin);
    assert.deepEqual(await response(allowed), { controlled: true, body: 'from-worker' });
    await borrowed.close(); borrowed = undefined;
    assert.deepEqual(await response(existing), { controlled: true, body: 'from-worker' });
    assert.equal(owner.isConnected(), true);
  } finally {
    await borrowed?.close();
    await observer?.close();
    await owner.close();
    await fixture.close();
  }
});

test('rejected page and missing context are insufficient evidence', async t => {
  const { chromium: raw } = await import('playwright');
  for (const contexts of [[], [{ newPage: async () => { throw Error('Target closed'); } }]]) {
    let disconnected = false;
    const connect = t.mock.method(raw, 'connectOverCDP', async () => ({ contexts: () => contexts, close: async () => { disconnected = true; } }));
    const browser = await chromium.connectOverCDP('http://127.0.0.1:1234');
    await assert.rejects(browser.newPage(), { exitCode: 78 });
    await browser.close();
    assert.equal(disconnected, true);
    connect.mock.restore();
  }
});

test('CLI with containing release and unreachable CDP exits 78', async t => {
  const { startFixture } = await import('../scripts/fixture-http.mjs');
  const { execFile } = await import('node:child_process');
  const commit = '1'.repeat(40);
  const fixture = await startFixture({ routes: new Map([['/app-release', { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: commit }) }]]) });
  t.after(() => fixture.close());
  const result = await new Promise(resolve => execFile(process.execPath, ['scripts/prove-client-anniversary-panel.mjs', '--origin', fixture.origin, '--expected-commit', commit, '--cdp-url', 'http://127.0.0.1:1'], { timeout: 15000 }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr })));
  assert.equal(result.code, 78, JSON.stringify(result));
});

test('real CDP context option coverage applies or refuses every migrated setting', async t => {
  const { startFixture } = await import('../scripts/fixture-http.mjs');
  const fixture = await startFixture();
  const port = new URL(fixture.origin).port;
  await fixture.close();
  let borrowed;
  const cases = [
    { key: 'baseURL', value: 'http://proof.invalid', refused: true },
    { key: 'colorScheme', value: 'dark', refused: true },
    { key: 'storageState', value: { cookies: [], origins: [] }, refused: true },
    { key: 'viewport', value: { width: 390, height: 844 }, observe: page => page.viewportSize() },
    { key: 'timezoneId', value: 'Asia/Tokyo', observe: page => page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) },
    { key: 'serviceWorkers', value: 'block', observe: page => page.evaluate(() => navigator.serviceWorker.controller), expected: null },
    { key: 'futureOption', value: true, refused: true },
  ];
  const { parseSync: parse } = await import('@babel/core');
  const { readdirSync, readFileSync } = await import('node:fs');
  const found = new Set();
  for (const file of readdirSync(new URL('../scripts/', import.meta.url)).filter(file => /^prove-.*\.mjs$/.test(file))) {
    const source = parse(readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8'), { sourceType: 'module' });
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && ['newContext', 'newPage'].includes(node.callee.property.name) && node.arguments.length) {
        const settings = node.arguments[0];
        assert.equal(settings.type, 'ObjectExpression', `${file} needs an explicit option coverage case`);
        for (const property of settings.properties) {
          assert.ok(property.key, `${file} needs coverage for spread settings`);
          found.add(property.key.name || property.key.value);
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    }
    visit(source);
  }
  assert.deepEqual([...found].sort(), cases.filter(entry => entry.key !== 'futureOption').map(entry => entry.key).sort());
  const owner = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  try {
    borrowed = await signedInEngine(`http://127.0.0.1:${port}`).launch();
    for (const entry of cases) await t.test(entry.key, async () => {
      for (const mode of ['newContext', 'newPage']) {
        const settings = { [entry.key]: entry.value };
        if (entry.refused) {
          await assert.rejects(borrowed[mode](settings), error => error.exitCode === 78 && error.message.includes(entry.key));
        } else {
          const context = mode === 'newContext' ? await borrowed.newContext(settings) : undefined;
          const page = context ? await context.newPage() : await borrowed.newPage(settings);
          await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: 'fixture' }));
          await page.goto('http://localhost/owned');
          assert.deepEqual(await entry.observe(page), 'expected' in entry ? entry.expected : entry.value);
          await page.close();
          await context?.close();
        }
      }
    });
    assert.equal(owner.isConnected(), true);
  } finally { await borrowed?.close(); await owner.close(); }
});


test('real CDP launch option coverage verifies existing settings or refuses them', async () => {
  const { startFixture } = await import('../scripts/fixture-http.mjs');
  const fixture = await startFixture();
  const port = new URL(fixture.origin).port;
  await fixture.close();
  const owner = await chromium.launch({ args: ['--enable-automation', `--remote-debugging-port=${port}`] });
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    for (const options of [{ args: required }, { headless: true }, { timeout: 5000 }, { cdpUrl: endpoint }]) {
      const borrowed = await signedInEngine(endpoint).launch(options);
      try { assert.equal(await (await borrowed.newPage()).evaluate(() => 42), 42); }
      finally { await borrowed.close(); }
    }
    for (const [key, options] of [
      ['args', { args: ['--proof-setting-not-present'] }],
      ['headless', { headless: false }],
      ['futureLaunchOption', { futureLaunchOption: true }],
    ]) await assert.rejects(signedInEngine(endpoint).launch(options), error => error.exitCode === 78 && error.message.includes(key));
    assert.equal(owner.isConnected(), true);
  } finally { await owner.close(); }
});
