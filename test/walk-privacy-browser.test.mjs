import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

const require = createRequire(import.meta.url);

test('walk privacy covers consecutive spec files and secondary pages', async t => {
  let writes = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') writes++;
    response.writeHead(request.method === 'POST' ? 200 : 429);
    response.end('synthetic');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = temporaryDirectory('doctorcre-walk-privacy-', t);
  const spec = `
import { expect } from ${JSON.stringify(require.resolve('@playwright/test'))};
import { test } from ${JSON.stringify(resolve('tests/walks/privacy.ts'))};
test('guards and diagnostics', async ({ page, context }, info) => {
  await page.goto('/status');
  const secondary = await context.newPage();
  await secondary.goto('/status');
  expect(info.annotations.filter(x => x.type === 'http-status' && x.description === 'document 429').length).toBe(2);
  for (const target of [page, secondary]) {
    expect(await target.evaluate(() => fetch('/write', { method: 'POST' }).then(() => false, () => true))).toBe(true);
  }
});`;
  for (const name of ['first', 'second']) writeFileSync(resolve(directory, `${name}.spec.ts`), spec);
  writeFileSync(resolve(directory, 'third.spec.ts'), `
import { test } from ${JSON.stringify(resolve('tests/walks/privacy.ts'))};
test('redacts private failures', async () => { throw new Error('SYNTHETIC_PRIVATE_BODY'); });`);
  const config = resolve(directory, 'playwright.config.ts');
  writeFileSync(config, `export default { testDir: '.', workers: 1, retries: 0, outputDir: './results', use: { baseURL: 'http://127.0.0.1:${server.address().port}', serviceWorkers: 'block' } };`);
  const result = await promisify(execFile)(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', config, '--reporter=json'], {
    timeout: 30_000, env: { ...process.env, PLAYWRIGHT_NO_COPY_PROMPT: '1' },
  }).then(() => assert.fail('The synthetic privacy failure must remain failed'), error => error);
  const report = JSON.parse(result.stdout);
  assert.equal(report.stats.expected, 2);
  assert.equal(report.stats.unexpected, 1);
  assert.doesNotMatch(result.stdout, /SYNTHETIC_PRIVATE_BODY/);
  assert.equal(writes, 0);
});
