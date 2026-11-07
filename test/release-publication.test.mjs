import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, canary } from './release-publication-fixture.mjs';
test('both actual publishers refuse ancestor, mismatched and external Wrangler entrypoints', t => {
  for (const installation of ['missing', 'mismatch', 'symlink']) {
    const f = fixture(t, { installation });
    const prepared = f.run('prepare-release');
    assert.equal(prepared.status, 0, prepared.stderr);
    for (const lane of ['production', 'staging']) {
      const result = f.run(`release-${lane}`);
      assert.notEqual(result.status, 0, `${lane}: ${installation} must refuse`);
      assert.match(result.stderr, /checkout-local locked Wrangler/);
      assert.deepEqual(f.rows(), [], 'untrusted executable must never receive credentials');
      assert.equal(result.stderr.includes(canary), false);
    }
  }
});
