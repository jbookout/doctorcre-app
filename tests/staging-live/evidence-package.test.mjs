import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packageEvidence } from '../../scripts/e2e-staging/package-evidence.mjs';

const canaries = [
  'Client Jane Doe 1842',
  'jane.doe+privacy@example.invalid',
  'client-4821',
  'synthetic-session-canary-7a4d9f2c8b6e1a3d5f0c9b7e2a4d6f8c',
  'synthetic-bearer-canary-4f7b1d9a6c3e8f2b5a0d7c1e9f4b6a3d',
  'synthetic-cookie-canary-8c2f5a1d7e4b9c6f3a0d8e2b5c7f1a4d',
];
const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: 'b'.repeat(40) };

function poisonFreeText(value, key = '') {
  if (Array.isArray(value)) return value.map(item => poisonFreeText(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, poisonFreeText(item, name)]));
  if (typeof value !== 'string') return value;
  if (key === 'status' || key === 'severity' || key === 'service' || key === 'environment' || key.endsWith('_commit')) return value;
  if (key === 'kind' && ['bug', 'ux'].includes(value)) return value;
  return `${value} ${canaries.join(' | ')}`;
}

function reports() {
  return poisonFreeText({
    'controls.json': {
      release, expectedScreens: 1, expectedExplorations: 1, expectedStates: 1,
      stateObligations: [{ target: 'staging-live', spec: { id: 'calendar-read', owner: '/calendar', kind: 'calendar-read' }, status: 'passed', sources: [{ key: 'control-1' }], result: { status: 'passed', auth: canaries[2] } }],
      screens: [{ target: 'staging-live', path: '/', name: 'Home', surface: 'app', reached: true, in_progress: false,
        controls: [{ key: 'staging-live/home/0123456789abcdef', target: 'staging-live', path: '/', selector: 'main button', role: 'button', name: 'Safe synthetic control', status: 'OBSERVED', signals: ['dom'], openers: [], evidence_path: 'evidence/safe.jpg',
          auth: { token: canaries[0] }, headers: [{ name: 'Authorization', value: `Bearer ${canaries[1]}` }], storageState: { cookies: [{ value: canaries[2] }] } }],
      }], setup: { cookies: [{ value: canaries[2] }] },
    },
    'findings.json': [{ id: 'synthetic-finding-1', surface: 'app', screen: 'Home', severity: 'minor', kind: 'bug', title: 'Synthetic safe finding', steps: ['Press the button'], expected: 'A response appears', actual: `No response; ${canaries[0]}`, evidence_path: 'evidence/finding.png', headers: canaries[1] }],
    'explorations.json': [{ target: 'staging-live', screen: 'Home', path: '/', agent: 'synthetic', steps: 3, status: 'complete', evidence: 'evidence/raw-trace.zip', storageState: canaries[2] }],
  });
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'doctorcre-evidence-package-'));
  const sourceDir = join(base, 'authenticated-run');
  const outputDir = join(base, 'upload-package');
  await mkdir(sourceDir, { mode: 0o700 });
  for (const [name, value] of Object.entries(reports())) await writeFile(join(sourceDir, name), JSON.stringify(value), { mode: 0o600 });
  await writeFile(join(sourceDir, 'coverage.md'), `Raw coverage ${canaries[0]}`, { mode: 0o600 });
  await mkdir(join(sourceDir, 'private'), { mode: 0o700 });
  await writeFile(join(sourceDir, 'private', 'storage-state.json'), JSON.stringify({ cookies: [{ name: '__Host-dealroom_session', value: canaries[2] }], origins: [{ localStorage: [{ name: 'access_token', value: canaries[1] }] }] }), { mode: 0o600 });
  await mkdir(join(sourceDir, 'playwright', 'results'), { recursive: true, mode: 0o700 });
  await writeFile(join(sourceDir, 'playwright', 'report.json'), JSON.stringify({ headers: { authorization: canaries[1] }, trace: canaries[0] }), { mode: 0o600 });
  await mkdir(join(sourceDir, 'evidence'), { mode: 0o700 });
  await writeFile(join(sourceDir, 'evidence', 'raw.jpg'), Buffer.from(canaries[0]), { mode: 0o600 });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, sourceDir, outputDir };
}

test('packages useful typed reports while synthetic auth canaries and private outputs stay out', async t => {
  const { sourceDir, outputDir } = await fixture(t);
  await packageEvidence({ sourceDir, outputDir });
  const names = (await readdir(outputDir)).sort();
  assert.deepEqual(names, ['controls.json', 'coverage.md', 'evidence-package.json', 'explorations.json', 'findings.json']);
  const packageFiles = await Promise.all(names.map(name => readFile(join(outputDir, name))));
  for (const canary of canaries) {
    const bytes = Buffer.from(canary);
    assert.ok(packageFiles.every(file => file.indexOf(bytes) === -1), `package bytes contained ${canary}`);
  }
  const controls = JSON.parse(await readFile(join(outputDir, 'controls.json'), 'utf8'));
  assert.equal(controls.schema, 'doctorcre-staging-evidence-controls.v2');
  assert.equal(controls.release.source_commit, 'a'.repeat(40));
  assert.equal(controls.release.carr_source_commit, 'b'.repeat(40));
  assert.equal(controls.screens[0].controlCount, 1);
  assert.equal(controls.screens[0].statusCounts.OBSERVED, 1);
  assert.equal('controls' in controls.screens[0], false);
  const findings = JSON.parse(await readFile(join(outputDir, 'findings.json'), 'utf8'));
  assert.equal(findings.count, 1);
  assert.equal(findings.severityCounts.minor, 1);
  const explorations = JSON.parse(await readFile(join(outputDir, 'explorations.json'), 'utf8'));
  assert.equal(explorations.attempted, 1);
  assert.equal(explorations.statusCounts.complete, 1);
  const coverage = await readFile(join(outputDir, 'coverage.md'), 'utf8');
  assert.match(coverage, /Screens reached: 1\/1/);
  assert.match(coverage, /OBSERVED 1/);
  assert.match(coverage, /does not establish that the control action was correct/);
  assert.match(coverage, /State obligations: 1\/1; passed 1/);
  assert.match(coverage, /Explorations attempted: 1\/1/);
  assert.match(coverage, /screenshots, traces/);
});

test('rejects unknown source files and leaves no upload package', async t => {
  const { sourceDir, outputDir } = await fixture(t);
  await writeFile(join(sourceDir, 'unclassified.json'), '{}');
  await assert.rejects(packageEvidence({ sourceDir, outputDir }), /unclassified source entry/);
  await assert.rejects(readFile(join(outputDir, 'controls.json')));
});

test('rejects symlinked reports and symlinked excluded roots', async t => {
  const { sourceDir, outputDir, base } = await fixture(t);
  await rm(join(sourceDir, 'findings.json'));
  await symlink(join(base, 'outside.json'), join(sourceDir, 'findings.json'));
  await assert.rejects(packageEvidence({ sourceDir, outputDir }), /symlink|unsafe/i);
  await rm(join(sourceDir, 'findings.json'));
  await writeFile(join(sourceDir, 'findings.json'), '[]');
  await rm(join(sourceDir, 'private'), { recursive: true });
  await symlink(join(base, 'missing-private'), join(sourceDir, 'private'));
  await assert.rejects(packageEvidence({ sourceDir, outputDir }), /symlink/i);
  await assert.rejects(readFile(join(outputDir, 'controls.json')));
});

test('refuses traversal into the authenticated source directory', async t => {
  const { sourceDir } = await fixture(t);
  await assert.rejects(packageEvidence({ sourceDir, outputDir: join(sourceDir, 'upload') }), /outside the authenticated run directory/);
});
