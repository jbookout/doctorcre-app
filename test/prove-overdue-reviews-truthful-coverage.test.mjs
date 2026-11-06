import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './proof-fixture-server.mjs';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
const script = 'scripts/prove-overdue-reviews-truthful-coverage.mjs';
const cli = args => new Promise((done, reject) => {
  const child = spawn(process.execPath, [script, ...args]); let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  child.on('error', reject); child.on('close', code => done({ code, stdout, stderr }));
});
test('declared CLI verifies deployed bytes and refuses contradictions or unavailable evidence', async t => {
  const outDir = temporaryDirectory('coverage-proof-', t);
  const built = await buildArtifact({ root: process.cwd(), outDir });
  const root = resolve(outDir, 'site'); let mode = 'valid', mutations = 0, requests = 0;
  const wrong = 'export function mountDealUpdateReviews() { return { refresh: async () => {}, dispose() {} }; }';
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    requests++; if (request.method !== 'GET') mutations++;
    if (mode === 'timeout') return;
    const path = decodeURIComponent(new URL(request.url, 'http://fixture').pathname);
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    if (path === '/app-release') return response.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: built.manifest.source_commit }));
    if (path === '/artifact-manifest.json') {
      const manifest = structuredClone(built.manifest);
      if (mode === 'manifest') return response.end('{}');
      if (mode === 'release') manifest.source_commit = 'f'.repeat(40);
      if (mode === 'assertion') {
        const entry = manifest.files.find(f => f.path === 'js/ui-deal-reviews.js');
        entry.bytes = Buffer.byteLength(wrong); entry.sha256 = createHash('sha256').update(wrong).digest('hex');
      }
      return response.end(JSON.stringify(manifest));
    }
    if (path === '/js/ui-deal-reviews.js' && mode === 'asset') return response.end('export const wrong = true;');
    if (path === '/js/ui-deal-reviews.js' && mode === 'assertion') return response.end(wrong);
    try { response.end(await readFile(file)); } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const declaration = JSON.parse(await readFile('proofs/requirements/overdue-reviews-truthful-coverage.json'));
  const args = declaration.assertions[0].predicate.match(/`([^`]+)`/)[1].split(' ').slice(2);
  args[args.indexOf('--origin') + 1] = origin;
  const passed = await cli(args); assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  const receipt = JSON.parse(passed.stdout); assert.ok(receipt.assertions.length > 20);
  assert.deepEqual([...new Set(receipt.assertions.map(a => a.width))], [390, 1440]);
  assert.ok(receipt.assets.length > 0); assert.ok(requests <= 10);
  for (const [failure, code] of [['manifest', 78], ['release', 78], ['asset', 1], ['assertion', 1], ['timeout', 78]]) {
    mode = failure;
    const failed = await cli(['--origin', origin, '--timeout-ms', failure === 'timeout' ? '100' : '30000']);
    assert.equal(failed.code, code, failure + failed.stdout + failed.stderr);
  }
  assert.equal(mutations, 0);
});
test('CLI rejects invalid origin and deadline', async () => {
  for (const args of [[], ['--origin', 'bad'], ['--origin', 'https://example.com/path'], ['--origin', 'https://example.com', '--timeout-ms', '0']]) assert.equal((await cli(args)).code, 1);
});
