import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove } from '../scripts/prove-lead-research-source-dates.mjs';

const run = promisify(execFile);
test('fixture proof CLI passes and rejects invalid origin', async () => {
  const pass = await run(process.execPath, ['scripts/prove-lead-research-source-dates.mjs', '--fixture']);
  assert.equal(JSON.parse(pass.stdout).ok, true);
  await assert.rejects(run(process.execPath, ['scripts/prove-lead-research-source-dates.mjs', '--fixture', '--origin', 'file:///bad']), error => error.code === 1 && JSON.parse(error.stdout).status === 'assertion_failure');
});
for (const mode of ['late launch', 'stalled evaluation']) test(`${mode} returns 78 and closes every acquired browser`, async () => {
  let acquired;
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  const engine = { launch: async () => {
    acquired = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS], headless: true });
    if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 250));
    settle();
    if (mode === 'stalled evaluation') {
      const newPage = acquired.newPage.bind(acquired);
      acquired.newPage = async options => {
        const page = await newPage(options);
        page.goto = () => new Promise(() => {});
        return page;
      };
    }
    return acquired;
  } };
  await assert.rejects(prove({ fixture: true, timeoutMs: mode === 'late launch' ? 50 : 1500, engine }), error => error.exitCode === 78);
  await settled;
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(acquired.isConnected(), false, 'zero owned browser survivors');
});
test('bounded CLI reports insufficient_evidence exit 78', async () => {
  await assert.rejects(run(process.execPath, ['scripts/prove-lead-research-source-dates.mjs', '--fixture', '--timeout-ms', '1']), error => error.code === 78 && JSON.parse(error.stdout).status === 'insufficient_evidence');
});

test('changed recorded observation fails fixture assertions', async t => {
  const root = temporaryDirectory('lead-dates-failure-', t);
  const recording = JSON.parse(await readFile(new URL('./fixtures/lead-research-source-dates/recordings.json', import.meta.url)));
  recording.detail.research.evidence[0].observed_at = '2020-01-01T12:00:00Z';
  const file = join(root, 'recordings.json');
  await writeFile(file, JSON.stringify(recording));
  await assert.rejects(run(process.execPath, ['scripts/prove-lead-research-source-dates.mjs', '--fixture', '--recording', file]), error => error.code === 1 && JSON.parse(error.stdout).status === 'assertion_failure');
});
