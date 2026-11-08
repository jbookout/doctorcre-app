import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, canary } from './release-publication-fixture.mjs';
test('both actual publishers refuse ancestor, mismatched and external Wrangler entrypoints', t => {
  for (const installation of ['missing', 'mismatch', 'symlink']) {
    const f = fixture(t);
    const prepared = f.run('prepare-release');
    assert.equal(prepared.status, 0, prepared.stderr);
    const provider = join(f.root, 'node_modules/wrangler');
    const entry = readFileSync(join(provider, 'bin/wrangler.js'), 'utf8');
    if (installation === 'missing') {
      rmSync(provider, { recursive: true, force: true });
      const bin = join(f.parent, 'node_modules/.bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'wrangler'), entry);
      chmodSync(join(bin, 'wrangler'), 0o755);
    } else if (installation === 'mismatch') {
      const path = join(provider, 'package.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({ ...manifest, version: '0.0.0' }));
    } else {
      const path = join(f.parent, 'external.js');
      writeFileSync(path, entry);
      rmSync(join(provider, 'bin/wrangler.js'));
      symlinkSync(path, join(provider, 'bin/wrangler.js'));
    }
    for (const lane of ['production', 'staging']) {
      const result = f.run(`release-${lane}`);
      assert.notEqual(result.status, 0, `${lane}: ${installation} must refuse`);
      assert.match(result.stderr, /checkout-local locked Wrangler/);
      assert.deepEqual(f.rows(), [], 'untrusted executable must never receive credentials');
      assert.equal(result.stderr.includes(canary), false);
    }
  }
});
