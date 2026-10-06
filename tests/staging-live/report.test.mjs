import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReport } from '../../scripts/e2e-staging/report.mjs';

test('partial coverage retains the planned denominator and synthetic setup receipt', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-coverage-'));
  await writeReport(output, {
    screens: [{ name: 'Synthetic', path: '/', surface: 'app', target: 'desktop', reached: true, controls: [] }],
    release: { source_commit: 'a'.repeat(40) },
    expectedScreens: 60,
    expectedExplorations: 90,
    setup: { complete: true, needs_restore: ['Synthetic archived lead'] },
  });
  const coverage = await readFile(join(output, 'coverage.md'), 'utf8');
  assert.match(coverage, /1\/60 screens reached/);
  assert.match(coverage, /0\/90 goals attempted/);
  assert.match(coverage, /Normal authenticated API setup: complete/);
  assert.match(coverage, /Synthetic archived lead/);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'findings.json'), 'utf8')), []);
});
