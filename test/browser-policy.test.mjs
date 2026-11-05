import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createChromiumLauncher } from '../scripts/browser-policy-internal.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';

function fakeEngine(launch) {
  const calls = [];
  const browser = Object.assign(new EventEmitter(), { close: async () => {} });
  return { calls, browser, launch: createChromiumLauncher({ async launch(options) {
    calls.push(options);
    return launch ? launch(options, browser) : browser;
  } }) };
}

for (const [form, args] of [
  ['absent', undefined], ['direct', CHROMIUM_SAFETY_ARGS],
  ['spread', [...CHROMIUM_SAFETY_ARGS, '--disable-gpu']],
  ['literal', ['--use-mock-keychain', '--password-store=basic', '--disable-gpu']],
]) test(`exact arguments preserve ${form} caller flags`, async () => {
  const engine = fakeEngine();
  const options = { headless: false, timeout: 1234, ...(args ? { args } : {}) };
  const browser = await engine.launch(options);
  assert.deepEqual(engine.calls[0].args, [...CHROMIUM_SAFETY_ARGS, ...(args?.includes('--disable-gpu') ? ['--disable-gpu'] : [])]);
  assert.equal(engine.calls[0].timeout, 1234);
  assert.equal(engine.calls[0].headless, false);
  assert.deepEqual(options.args, args);
  await browser.close();
});

test('invalid options and conflicting flags refuse before allocating or launching', async () => {
  const engine = fakeEngine();
  for (const options of [null, [], true, { executablePath: 'other' }, { ignoreDefaultArgs: true },
    { env: {} }, { proxy: {} }, { timeout: 0 }, { timeout: Infinity }, { timeout: -1 },
    { timeout: '1' }, { timeout: 120001 }, { headless: 1 }, { args: 'flag' }, { args: [null] }, { args: ['file.html'] },
    { args: ['--password-store=secret'] }, { args: ['--use-mock-keychain=false'] },
    { args: ['--no-use-mock-keychain'] }, { args: ['--user-data-dir=/elsewhere'] },
    { args: ['--foo=one', '--foo=two'] }, { args: ['--foo', '--foo=two'] },
    { args: ['--password-store', 'basic'] }, { args: ['--foo\n--password-store=secret'] }, { args: Array(129).fill('--disable-gpu') },
    { args: ['--' + 'x'.repeat(8192)] }, { args: Array(1) }, { [Symbol('option')]: true }]) {
    await assert.rejects(engine.launch(options), /Chromium/);
  }
  assert.equal(engine.calls.length, 0);
});

test('successful close releases only its lease and concurrent close is idempotent', async () => {
  let closes = 0;
  const engine = fakeEngine(async (_, browser) => {
    browser.close = async () => { closes++; };
    return browser;
  });
  const other = fakeEngine();
  const browser = await engine.launch();
  const second = await other.launch();
  const options = engine.calls[0];
  const directory = options.env.TMPDIR;
  assert.equal(options.env.TMP, directory);
  assert.equal(options.env.TEMP, directory);
  assert.equal(existsSync(directory), true);
  assert.notEqual(directory, other.calls[0].env.TMPDIR);
  await Promise.all([browser.close(), browser.close()]);
  await browser.close();
  assert.equal(closes, 1);
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(other.calls[0].env.TMPDIR), true);
  await second.close();
});

test('launch rejection releases the allocated lease', async () => {
  const failure = new Error('launch rejected');
  const engine = fakeEngine(async () => { throw failure; });
  await assert.rejects(engine.launch(), error => error === failure);
  assert.equal(existsSync(engine.calls[0].env.TMPDIR), false);
});

test('close failure releases its lease and repeated close preserves the rejection', async () => {
  const failure = new Error('close failed');
  let closes = 0;
  const engine = fakeEngine(async (_, browser) => {
    browser.close = async () => { closes++; throw failure; };
    return browser;
  });
  const browser = await engine.launch();
  await assert.rejects(browser.close(), error => error === failure);
  await assert.rejects(browser.close(), error => error === failure);
  assert.equal(existsSync(engine.calls[0].env.TMPDIR), false);
  assert.equal(closes, 1);
});

test('browser disconnection releases its lease before a later close', async () => {
  const engine = fakeEngine();
  const browser = await engine.launch();
  browser.emit('disconnected');
  assert.equal(existsSync(engine.calls[0].env.TMPDIR), false);
  await browser.close();
});

for (const mode of ['failure', 'timeout']) test(`owned child ${mode} cleans up after observed exit`, async () => {
  let exited = false;
  let timer;
  const engine = fakeEngine(options => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', mode === 'failure' ? 'process.exit(7)' : 'setInterval(() => {}, 1000)'],
      { env: options.env, stdio: 'ignore' });
    if (mode === 'timeout') timer = setTimeout(() => child.kill('SIGKILL'), options.timeout);
    child.once('error', reject);
    child.once('exit', () => {
      exited = true;
      clearTimeout(timer);
      assert.equal(existsSync(options.env.TMPDIR), true);
      reject(new Error(mode));
    });
  }));
  await assert.rejects(engine.launch({ timeout: 100 }), new RegExp(mode));
  assert.equal(exited, true);
  assert.equal(existsSync(engine.calls[0].env.TMPDIR), false);
});
