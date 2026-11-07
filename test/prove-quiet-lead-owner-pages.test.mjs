import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { prove } from '../scripts/prove-quiet-lead-owner-pages.mjs';
import { assertProofDeadlineCleanup } from './proof-browser-harness.mjs';
const run = promisify(execFile), commit = '1'.repeat(40), descendant = '2'.repeat(40);
const args = ['scripts/prove-quiet-lead-owner-pages.mjs', '--fixture', '--expected-commit', commit];
test('fixture CLI passes and containing release assertion failure exits 1', async t => {
  const result = await run(process.execPath, args);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const root = temporaryDirectory('quiet-proof-', t), path = join(root, 'bad.json');
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
  snapshot.proposals[0].owner = 1; await writeFile(path, JSON.stringify(snapshot));
  await assert.rejects(run(process.execPath, [...args, '--recording', path]), error => error.code === 1);
});
for (const kind of ['equal', 'descendant', 'older', 'unrelated', 'unknown']) test(`release ${kind}`, async () => {
  const source = kind === 'equal' ? commit : kind === 'unknown' ? undefined : descendant;
  const options = { fixture: true, expectedCommit: commit, readRelease: async () => ({ source_commit: source }), ancestry: async () => kind === 'descendant' };
  if (['equal', 'descendant'].includes(kind)) assert.equal((await prove(options)).ok, true);
  else await assert.rejects(prove(options), { exitCode: 78 });
});
test('missing session is insufficient evidence', async () => {
  await assert.rejects(prove({ expectedCommit: commit, readRelease: async () => ({ source_commit: commit }) }), { exitCode: 78 });
});
test('no natural subjects is insufficient evidence', async t => {
  const root = temporaryDirectory('quiet-empty-', t), path = join(root, 'empty.json');
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
  snapshot.proposals = []; await writeFile(path, JSON.stringify(snapshot));
  await assert.rejects(prove({ fixture: true, expectedCommit: commit, recordingUrl: path }), { exitCode: 78 });
});
for (const mode of ['late launch', 'stalled evaluation']) test(`deadline cleanup ${mode}`, async t => {
  await assertProofDeadlineCleanup(t, { entry: args[0], args: args.slice(1), mode, timeoutMs: 2000 });
});
