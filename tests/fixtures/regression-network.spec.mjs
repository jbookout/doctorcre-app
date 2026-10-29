import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

for (const outbound of [
  'http://127.0.0.1:4682/api/unexpected-regression-request',
  'https://unexpected.fixture.test/unexpected-regression-request',
]) test(`regression runner fails a caught outbound request to ${outbound}`, async ({}, testInfo) => {
  test.setTimeout(60_000);
  const output = testInfo.outputPath('runner');
  const fixture = testInfo.outputPath('unexpected.e2e.ts');
  const config = resolve(`.e2e.network-rejection-${process.pid}.config.ts`);
  await mkdir(testInfo.outputDir, { recursive: true });
  await writeFile(config, `import config from ${JSON.stringify(resolve('e2e.regressions.config.ts'))};
export default { ...config, tests: [${JSON.stringify(relative(process.cwd(), fixture))}] };
`);
  await writeFile(fixture, `import { reproTest, refuseReads } from ${JSON.stringify(resolve('tests/regressions/support.mjs'))};
const test = reproTest();
test('unexpected outbound request', { requires: ['browser'] }, async ({ app, browser }) => {
  await refuseReads(app, browser);
  await browser.route(new URL('/network-probe', app.baseUrl).href, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Network probe</title>' }));
  await app.open('/network-probe');
  await browser.evaluate(async () => {
    await fetch('${outbound}').catch(() => {});
  });
});
`);
  try {
    const result = await run(process.execPath, [
      'node_modules/e2e/dist/cli/bin.js', 'run', '--config', config,
      '--target', 'app-desktop-dark', '--output', output,
    ], { timeout: 50_000, encoding: 'utf8' }).then(
      value => ({ code: 0, ...value }),
      error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
    await testInfo.attach('runner-output', { body: `${result.stdout}\n${result.stderr}`, contentType: 'text/plain' });
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(`Unexpected regression request outside fixture origin: ${outbound}`);
  } finally {
    await rm(config, { force: true });
  }
});
