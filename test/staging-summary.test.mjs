import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('../scripts/staging-summary.mjs', import.meta.url);

test('staging summary counts outcomes and names flakes and first failure errors across nested suites', async t => {
  const directory = await temporaryDirectory('staging-summary-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = join(directory, 'results.json');
  await writeFile(report, JSON.stringify({
    stats: { expected: 3, unexpected: 1, flaky: 1, skipped: 2 },
    suites: [{ suites: [{ specs: [
      { title: 'loads account', file: 'tests/staging/account.spec.ts', line: 4,
        tests: [{ projectName: 'chromium', status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] }] },
      { title: 'opens tour', file: 'tests/staging/tours.spec.ts', line: 8,
        tests: [{ projectName: 'chromium', status: 'unexpected', results: [
          { status: 'failed', error: { message: '\u001b[31mError: route unavailable\u001b[39m\nCall log: details' } },
          { status: 'timedOut', error: { message: 'Error: retry timed out' } },
        ] }] },
    ] }] }], errors: [],
  }));
  const result = spawnSync(process.execPath, [script.pathname, report], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 passed, 1 failed, 1 flaky, 2 skipped/);
  assert.match(result.stdout, /Flaky tests[\s\S]*loads account/);
  assert.match(result.stdout, /tests\/staging\/tours.spec.ts:8.*opens tour.*Error: route unavailable/);
  assert.doesNotMatch(result.stdout, /Call log:|retry timed out|\u001b/);
});

test('missing result report fails instead of claiming zero failures', () => {
  const result = spawnSync(process.execPath, [script.pathname, '/nonexistent/staging-results.json'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});
