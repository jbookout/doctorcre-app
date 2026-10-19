import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = new URL('../', import.meta.url);

test('Share navigation failure output omits the confidential bearer', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journey-output-'));
  try {
    await writeFile(join(directory, 'playwright.config.mjs'), 'export default { testDir: ".", timeout: 10000, workers: 1, reporter: "line" };');
    await writeFile(join(directory, 'navigation.spec.mjs'), `
import { test } from ${JSON.stringify(new URL('node_modules/@playwright/test/index.mjs', root).href)};
import { fixture, localFixture } from ${JSON.stringify(new URL('tests/fixtures/staging-journeys.spec.mjs', root).href)};
import { shareLifecycle } from ${JSON.stringify(new URL('tests/staging/journey-flows.mjs', root).href)};
test('forced confidential navigation failure', async ({ browser }) => {
  const local = await localFixture(browser);
  await local.page.addInitScript(() => { crypto.getRandomValues = bytes => { bytes.fill(17); return bytes; }; });
  await local.page.context().route('**/share', route => route.abort('failed'));
  try { await shareLifecycle(local.page, fixture); } finally { await local.close(); }
});
`);
    const result = await execute(process.execPath, [fileURLToPath(new URL('node_modules/@playwright/test/cli.js', root)),
      'test', '--config', join(directory, 'playwright.config.mjs'), '--grep', 'forced confidential navigation'],
    { cwd: directory, timeout: 45000, maxBuffer: 1024 * 1024 }).catch(error => error);
    assert.equal(result.code, 1, 'the injected browser navigation must fail');
    const output = result.stdout + result.stderr;
    assert.equal(output.includes(Buffer.alloc(32, 17).toString('base64url')), false,
      'Playwright output must omit the synthetic bearer');
    assert.equal(output.includes('Share navigation failed'), true, 'the failure must retain a safe navigation diagnostic');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
