import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { prove, parseArgs } from '../scripts/prove-deal-tours-revoked-controls.mjs';

const runner = 'scripts/prove-deal-tours-revoked-controls.mjs';
function cli(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [runner, ...args]);
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('close', code => resolve({ code, output }));
  });
}
test('proof CLI documents and rejects invalid arguments', async () => {
  assert.equal((await cli(['--help'])).code, 0);
  for (const args of [[], ['--origin', 'file:///tmp'], ['--origin', 'https://example.com/path'], ['--origin', 'http://localhost', '--timeout-ms', '0'], ['--wat']]) assert.equal((await cli(args)).code, 1);
});
test('proof CLI fails closed for unavailable identity, missing export and failed UI assertions', async t => {
  let mode = 'release';
  const server = createServer((request, response) => {
    if (request.url === '/app-release') {
      response.writeHead(mode === 'release' ? 503 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ service: 'doctorcre-app', source_commit: '1'.repeat(40) }));
    } else {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(mode === 'export' ? 'export {}' : 'export function mountDealTours() { throw Error("fixture assertion failure"); }');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [next, expected] of [['release', /Release identity unavailable/], ['export', /Missing mountDealTours export/], ['assertion', /fixture assertion failure/]]) {
    mode = next;
    const result = await cli(['--origin', origin, '--timeout-ms', '30000']);
    assert.equal(result.code, 1);
    assert.match(result.output, expected);
  }
});
test('proof command imports served artifact, refuses retired re-entry and permits fresh verified mount', async t => {
  const artifact = await temporaryDirectory('revoked-controls-', t);
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir: artifact, commit: '1'.repeat(40) });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: `${artifact}/site` } });
  t.after(() => server.stop());
  const screenshotDir = fileURLToPath(new URL('../out/test-artifacts/revoked-controls', import.meta.url));
  await mkdir(screenshotDir, { recursive: true });
  const receipt = await prove({ origin: server.url, timeoutMs: 30000, screenshotDir });
  await writeFile(`${screenshotDir}/receipt.json`, JSON.stringify(receipt, null, 2));
  assert.equal(receipt.assertions.length, 4);
  assert.ok(receipt.loadedModuleUrls.includes(`${server.url}/js/ui-deal-tours.js`));
  const declaration = JSON.parse(await readFile(new URL('../proofs/requirements/deal-tours-revoked-controls.json', import.meta.url)));
  assert.equal(declaration.assertions[0].predicate.match(/`([^`]+)`/)[1], `node ${runner} --origin https://app.doctorcre.com --timeout-ms 30000`);
  const result = await cli(['--origin', server.url, '--timeout-ms', '30000']);
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(result.output).origin, server.url);
  assert.equal((await cli(['--origin', server.url, '--timeout-ms', '1'])).code, 1);
  assert.equal(parseArgs(['--origin', server.url]).timeoutMs, 30000);
});
