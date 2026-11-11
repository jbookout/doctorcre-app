import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ownedBrowserProcesses } from './proof-browser-harness.mjs';
import { launchProofBrowser } from '../scripts/app-release-reader.mjs';
import { chromium } from '../scripts/proof-browser.mjs';

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

test('diagnostic setup failure closes the acquired browser and removes its directory', async t => {
  let root, closes = 0;
  const reason = Error('diagnostic collector unavailable');
  await stubLaunch(t, async options => {
    root = options.env.TMPDIR;
    return { close: async () => { closes++; }, _connection: { toImpl() { throw reason; } } };
  });
  await assert.rejects(chromium.launch(), error => error === reason);
  assert.equal(closes, 1);
  assert.equal(existsSync(root), false);
});
