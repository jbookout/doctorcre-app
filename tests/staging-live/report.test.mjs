import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReport, sweepFindings } from '../../scripts/e2e-staging/report.mjs';

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

test('resume reports retain interrupted attempts and findings through exploration rewrites', async t => {
  const output = await mkdtemp(join(tmpdir(), 'staging-resume-report-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const partial = {
    name: 'Home', path: '/', surface: 'app', target: 'desktop', reached: true,
    failure: { phase: 'session-preflight', code: 'session-preflight-failed', openers: ['Record'] },
    controls: Array.from({ length: 99 }, (_, index) => ({ key: `old-${index}`, name: `Control ${index}`, selector: `#control${index}`, openers: [], status: index === 0 ? 'DEAD' : 'OBSERVED', evidence_path: `/synthetic/evidence/${index}.png` })),
  };
  const history = [{ screen: partial, findings: sweepFindings([partial]) }];
  const preserved = structuredClone(history);
  const screens = [{ ...partial, failure: null, attempt_id: '40000000-0000-4000-8000-000000000001', controls: [{ ...partial.controls[0], status: 'OBSERVED', evidence_path: '/synthetic/evidence/new.png' }] }];
  await writeReport(output, { screens, history, release: { source_commit: 'a'.repeat(40) }, expectedScreens: 60 });
  const checkpoint = JSON.parse(await readFile(join(output, 'controls.json'), 'utf8'));
  assert.deepEqual(checkpoint.history, preserved);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'findings.json'), 'utf8')), preserved[0].findings);
  assert.match(await readFile(join(output, 'coverage.md'), 'utf8'), /1\/60 screens reached; 1 controls enumerated/);
  assert.match(await readFile(join(output, 'coverage.md'), 'utf8'), /Previous interrupted attempts/);
  assert.match(await readFile(join(output, 'coverage.md'), 'utf8'), /99/);
  await writeReport(output, { screens: checkpoint.screens, history: checkpoint.history, release: checkpoint.release, explorations: [{ target: 'desktop', screen: 'Home', agent: 'synthetic-reviewer', steps: 1, status: 'completed' }], expectedScreens: 60 });
  assert.deepEqual(JSON.parse(await readFile(join(output, 'controls.json'), 'utf8')).history, preserved);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'findings.json'), 'utf8')), preserved[0].findings);
  assert.deepEqual(history, preserved);
});

test('retained reports reject source drift and malformed metadata before overwriting evidence', async t => {
  const output = await mkdtemp(join(tmpdir(), 'staging-report-source-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: 'b'.repeat(40) };
  await writeReport(output, { release });
  const path = join(output, 'controls.json');
  const original = await readFile(path, 'utf8');
  await assert.rejects(writeReport(output, { release: { ...release, source_commit: 'c'.repeat(40) } }), /different source pair/);
  assert.equal(await readFile(path, 'utf8'), original);
  await writeFile(path, JSON.stringify({ ...JSON.parse(original), explorations: [null] }));
  const malformed = await readFile(path, 'utf8');
  await assert.rejects(writeReport(output, { release }), /valid source-bound checkpoint/);
  assert.equal(await readFile(path, 'utf8'), malformed);
});
