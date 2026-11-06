import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import * as proof from '../scripts/prove-calendar-meeting-end-time.mjs';
const { prove } = proof;

test('acceptance recordings retain producer timestamps and response flags', () => {
  assert.ok(proof.calendarRecordings, 'producer-recorded calendar responses are required');
  const { provenance, records } = proof.calendarRecordings;
  assert.equal(provenance.function, 'calendarSection');
  assert.match(provenance.source_commit, /^[a-f0-9]{40}$/);
  assert.match(provenance.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(records.length, 12);
  for (const { response } of records) {
    assert.equal(response.source, 'outlook_local_store');
    assert.equal(response.malformed_items, undefined);
    assert.ok(Array.isArray(response.notes));
    for (const item of response.items) {
      for (const key of ['start', 'end']) assert.match(item[key], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      for (const key of ['all_day', 'time_changed', 'schedule_conflict']) assert.equal(typeof item[key], 'boolean');
      assert.equal(item.schedule_conflict, item.schedule_conflicts.length > 0);
    }
  }
});
const exec = promisify(execFile);

test('proof CLI accepts a working-tree fixture and rejects a broken deployed module', async t => {
  const out = temporaryDirectory('meeting-proof-cli-');
  t.after(() => rm(out, { recursive: true, force: true }));
  await buildArtifact({ root: process.cwd(), outDir: out });
  const args = ['scripts/prove-calendar-meeting-end-time.mjs', '--fixture-root', join(out, 'site')];
  const pass = await exec(process.execPath, args);
  const receipt = JSON.parse(pass.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.evidence, 'local_fixture');
  assert.equal(receipt.production_acceptance, 'insufficient_evidence');
  assert.equal(receipt.observations.length, 4);
  await writeFile(join(out, 'site/js/ui-calendar-panels.js'), 'export async function mountCalendarPanels() { throw Error("broken fixture module"); }');
  await assert.rejects(exec(process.execPath, args), error => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stdout).error, /broken fixture module/);
    return true;
  });
});

for (const mode of ['stalled evaluation', 'late launch']) test(`proof closes acquired browser after ${mode}`, async t => {
  const root = temporaryDirectory('meeting-proof-timeout-');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'js'), { recursive: true });
  await writeFile(join(root, 'js/ui-calendar-panels.js'), '');
  t.after(() => rm(root, { recursive: true, force: true }));
  let owned, acquisition, evaluating = false;
  t.after(async () => { await acquisition?.catch(() => {}); await owned?.close(); });
  const engine = { launch(options) {
    acquisition = (async () => {
      owned = await chromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS], timeout: 10000 });
      if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 100));
      else {
        const newPage = owned.newPage.bind(owned);
        owned.newPage = async (...args) => {
          const page = await newPage(...args);
          page.evaluate = () => { evaluating = true; return new Promise(() => {}); };
          return page;
        };
      }
      return owned;
    })();
    return acquisition;
  } };
  await assert.rejects(prove({ fixtureRoot: root, timeoutMs: mode === 'late launch' ? 40 : 3000, engine }), error => error.exitCode === 78);
  await acquisition;
  await new Promise(resolve => setTimeout(resolve, 100));
  if (mode === 'stalled evaluation') assert.equal(evaluating, true);
  assert.equal(owned.isConnected(), false, 'zero surviving owned browser processes');

});
