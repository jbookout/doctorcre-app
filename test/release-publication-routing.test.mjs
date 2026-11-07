import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, canary } from './release-publication-fixture.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
test('provider runner owns credential routing across status, upload, promotion and staging bootstrap', t => {
  for (const lane of ['production', 'staging']) {
    const source = readFileSync(join(ROOT, `scripts/release-${lane}.mjs`), 'utf8');
    assert.doesNotMatch(source, /env:\s*.*CLOUDFLARE_API_TOKEN|command === "npx"/);
    const f = fixture(t);
    assert.equal(f.run('prepare-release').status, 0);
    const result = f.run(`release-${lane}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.rows().length, lane === 'production' ? 5 : 4);
    assert.ok(f.rows().every(row => row.deploy && !row.unrelated && row.color === '1'));
    if (lane === 'staging') {
      writeFileSync(join(f.parent, 'bootstrap'), 'synthetic missing Worker');
      const bootstrap = f.run('release-staging');
      assert.equal(bootstrap.status, 0, bootstrap.stderr);
      assert.equal(f.rows().at(-2).args[0], 'deploy');
    }
    assert.equal(readFileSync(f.trace, 'utf8').includes(canary), false);
  }
});
