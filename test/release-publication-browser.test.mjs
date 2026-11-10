import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './release-publication-fixture.mjs';
test('real browser preparation preserves tracked source and both publishers accept its artifact', t => {
  const f = fixture(t, { browser: true });
  const prepared = f.run('prepare-release');
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  assert.equal(f.git(['status', '--porcelain', '--untracked-files=all']), '', 'preparation leaves source clean');
  assert.ok(existsSync(join(f.root, 'out/test-artifacts/w12/brief-desktop.png')), 'real browser capture was retained outside tracked paths');
  for (const lane of ['production', 'staging']) {
    const result = f.run(`release-${lane}`);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(f.rows().filter(row => row.args.includes('upload')).length, 2);
});

