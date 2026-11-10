import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = new URL('../', import.meta.url);

for (const [name, link, diagnostic] of [
  ['navigation failure', '`${origin}/share#token=${token}`', 'Share navigation failed'],
  ['invalid token assertion', '`${origin}/share#token=${token}!`', 'confidential Share URL has the required shape'],
  ['malformed URL', '`invalid-url-${token}`', 'Malformed confidential Share URL'],
]) test(`Share ${name} output omits the confidential bearer`, { timeout: 60000 }, async () => {
  const directory = await temporaryDirectory('journey-output-');
  try {
    await writeFile(join(directory, 'playwright.config.mjs'), 'export default { testDir: ".", timeout: 10000, workers: 1, reporter: "line", use: { baseURL: "http://share.invalid" } };');
    await writeFile(join(directory, 'navigation.spec.mjs'), `
import { test } from ${JSON.stringify(new URL('node_modules/@playwright/test/index.mjs', root).href)};
import { navigateConfidentialShare } from ${JSON.stringify(new URL('tests/staging/journey-flows.mjs', root).href)};
test('forced confidential failure', async ({ page }) => {
  const origin = 'http://share.invalid';
  const token = Buffer.alloc(32, 17).toString('base64url');
  await page.context().route('**/*', route => route.abort('failed'));
  await navigateConfidentialShare(page, ${link});
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
    assert.doesNotMatch(output, /Test timeout of \d+ms exceeded/, 'a test timeout cannot prove confidential failure handling');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
