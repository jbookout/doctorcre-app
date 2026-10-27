import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = new URL('../', import.meta.url);

for (const [name, trigger, diagnostic] of [
  ['navigation failure', `await local.page.context().route('**/share', route => route.abort('failed'));`, 'Share navigation failed'],
  ['invalid token assertion', `await local.page.addInitScript(() => {
    const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(HTMLInputElement.prototype, 'value', { ...value, set(input) {
      value.set.call(this, this.id === 'share-url' && input ? input + '!' : input);
    } });
  });`, 'confidential Share URL has the required shape'],
]) test(`Share ${name} output omits the confidential bearer`, { timeout: 60000 }, async () => {
  const directory = await temporaryDirectory(join(tmpdir(), 'journey-output-'));
  try {
    await writeFile(join(directory, 'playwright.config.mjs'), 'export default { testDir: ".", timeout: 10000, workers: 1, reporter: "line" };');
    await writeFile(join(directory, 'navigation.spec.mjs'), `
import { test } from ${JSON.stringify(new URL('node_modules/@playwright/test/index.mjs', root).href)};
import { fixture, localFixture } from ${JSON.stringify(new URL('tests/fixtures/staging-journeys.spec.mjs', root).href)};
import { shareLifecycle } from ${JSON.stringify(new URL('tests/staging/journey-flows.mjs', root).href)};
test('forced confidential failure', async ({ browser }) => {
  const local = await localFixture(browser);
  await local.page.addInitScript(() => { crypto.getRandomValues = bytes => { bytes.fill(17); return bytes; }; });
  ${trigger}
  try { await shareLifecycle(local.page, fixture); } finally { await local.close(); }
});
`);
    const result = await execute(process.execPath, [fileURLToPath(new URL('node_modules/@playwright/test/cli.js', root)),
      'test', '--config', join(directory, 'playwright.config.mjs'), '--grep', 'forced confidential failure'],
    { cwd: directory, timeout: 45000, maxBuffer: 1024 * 1024 }).catch(error => error);
    assert.equal(result.code, 1, 'the injected confidential Share failure must occur');
    const output = result.stdout + result.stderr;
    assert.equal(output.includes(Buffer.alloc(32, 17).toString('base64url')), false,
      'Playwright output must omit the synthetic bearer');
    assert.equal(output.includes(diagnostic), true, 'the failure must retain a safe diagnostic');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
