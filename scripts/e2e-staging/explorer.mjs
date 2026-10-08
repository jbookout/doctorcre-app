import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function explorer40() {
  const entry = new URL('../../node_modules/e2e/dist/explore/index.js', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('../../node_modules/e2e/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.17.0', 'Revalidate the private exploration adapter when upgrading e2e');
  // Revalidated 0.17.0: explore resolves maxSteps through STEP_BOUNDS before run.
  const digest = createHash('sha256').update(await readFile(entry)).digest('hex');
  assert.equal(digest, '60a144ff5efd18b0df625aedc9d181cb3bed2579ca32071b957062aff538f8ff', 'Revalidate the reviewed exploration entry when its source changes');
  const module = await import(entry);
  assert.deepEqual(module.STEP_BOUNDS, { min: 1, max: 12, default: 8 }, 'The pinned upstream limit changed');
  // The pinned runner has no public override above twelve. Raising this single
  // in-memory bound preserves its planner, session setup, traces and reports.
  module.STEP_BOUNDS.max = 40;
  return module.explore;
}
