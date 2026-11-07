import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCrossRepositoryImport, repositoryFiles } from '../scripts/repository-boundaries.mjs';

test('repository ownership distinguishes source paths, runtime packages and development packages', () => {
  for (const path of ['js/runtime.js', 'src/worker.js', 'tests/integration.mjs', 'scripts/probe.mjs', '.e2e/trace/error-context.md', 'out/receipt.md']) {
    for (const owner of ['carr-system', 'mcp-server', 'control-room']) {
      assert.equal(hasCrossRepositoryImport(`import('../${owner}/src/module.js')`, path), true);
      assert.equal(hasCrossRepositoryImport(`import('/tmp/${owner}/src/module.js')`, path), true);
      assert.equal(hasCrossRepositoryImport(`import('${owner}/entry.js')`, path), !/^(tests|scripts|out|\.e2e)\//.test(path));
    }
    assert.equal(hasCrossRepositoryImport("import('./control-room-model.js')", path), false);
    assert.equal(hasCrossRepositoryImport("import('playwright')", path), false);
  }
});


test('source checks include tracked ignored files and pending source but exclude ignored run artifacts', async t => {
  const { temporaryDirectory } = await import('../scripts/temp-directory.mjs');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const { basename } = await import('node:path');
  const root = temporaryDirectory('repository-files-', t);
  execFileSync('git', ['init', '-q', root]);
  await writeFile(root + '/.gitignore', '.e2e/\nignored.mjs\n');
  await mkdir(root + '/.e2e');
  await writeFile(root + '/.e2e/error-context.md', 'Generated execution receipt');
  await writeFile(root + '/ignored.mjs', 'export const tracked = true;');
  execFileSync('git', ['add', '-f', 'ignored.mjs'], { cwd: root });
  await writeFile(root + '/pending.mjs', 'export const pending = true;');
  assert.deepEqual(repositoryFiles(root).map(path => basename(path)).sort(), ['.gitignore', 'ignored.mjs', 'pending.mjs']);
});
