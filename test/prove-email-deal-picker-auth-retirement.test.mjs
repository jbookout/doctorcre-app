import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { uiAssets } from '../scripts/ui-bundle.mjs';

let assets;
before(async () => { assets = await uiAssets(path => readFile(path, 'utf8')); });
const servers = [];
after(async () => { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); });
async function fixture(mode) {
  const release = { service: 'doctorcre-app', source_commit: 'a'.repeat(40) };
  const manifest = { schema: 'doctorcre-static-artifact.v1', source_commit: release.source_commit, files: [...assets].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) };
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (mode === 'timeout') return;
    if (req.url === '/app-release') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(release)); return; }
    if (req.url === '/artifact-manifest.json') { res.end(mode === 'malformed' ? '{}' : JSON.stringify(manifest)); return; }
    const bytes = assets.get(req.url.slice(1));
    if (!bytes || mode === 'unavailable') { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'text/javascript');
    res.end(mode === 'wrong-asset' ? 'wrong' : bytes);
  });
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, calls: () => calls };
}
function cli(origin, timeout = 30000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/prove-email-deal-picker-auth-retirement.mjs', '--origin', origin, '--timeout-ms', String(timeout)]);
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}
test('exact CLI executes manifest-bound fixture module', async () => {
  const f = await fixture('valid'); const result = await cli(f.origin);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.release.source_commit, 'a'.repeat(40));
  assert.ok(receipt.assertions.includes('board denial {"status":401}'));
  assert.ok(receipt.assets.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.ok(f.calls() <= 10);
});
for (const [mode, code] of [['malformed', 1], ['wrong-asset', 1], ['unavailable', 78], ['timeout', 78]]) test(`CLI rejects ${mode}`, async () => {
  const f = await fixture(mode); const result = await cli(f.origin, mode === 'timeout' ? 50 : 30000);
  assert.equal(result.code, code, result.stderr); assert.ok(f.calls() <= 10);
});
test('CLI rejects deployed module with failed behavioral assertions', async () => {
  const original = assets;
  const bad = Buffer.from('export const actionModel=()=>({state:{kind:"idle"}}); export function mountEmailActions(){throw Error("Broken deployed mount")}');
  assets = new Map([['js/ui-email-actions.js', bad]]);
  const f = await fixture('valid');
  const result = await cli(f.origin);
  assets = original;
  assert.equal(result.code, 1); assert.match(result.stderr, /Broken deployed mount/);
});
