import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const script = 'scripts/prove-deal-checklist-malformed-recovery.mjs';
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('proof CLI help and invalid arguments', async () => {
  assert.equal((await cli(['--help'])).code, 0);
  for (const args of [[], ['--origin', 'bad'], ['--origin', 'https://example.com/path'], ['--origin', 'https://example.com', '--timeout-ms', '0']]) {
    assert.notEqual((await cli(args)).code, 0);
  }
});

test('declaration command reaches real fixture assertions and refuses missing proof inputs', async t => {
  let mode = 'valid';
  let mutations = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'GET') mutations++;
    const path = new URL(request.url, 'http://fixture').pathname;
    if (mode === 'timeout') return;
    if (path === '/app-release') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(mode === 'release' ? {} : { service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }));
      return;
    }
    response.setHeader('content-type', 'text/javascript');
    if (path === '/js/deal-checklist.js' && mode === 'export') return response.end('export const wrong = true;');
    if (path === '/js/deal-checklist.js' && mode === 'assertion') return response.end('export function renderDealChecklist() { return ""; }');
    try { response.end(await readFile(new URL(`..${path}`, import.meta.url))); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const declaration = JSON.parse(await readFile('proofs/requirements/deal-checklist-malformed-recovery.json'));
  const args = declaration.assertions[0].predicate.match(/`([^`]+)`/)[1].split(' ').slice(2);
  args[args.indexOf('--origin') + 1] = origin;
  const result = await cli(args);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.origin, origin);
  assert.equal(receipt.assertions.length, 3);
  assert.ok(receipt.loaded_module_urls.includes(`${origin}/js/deal-checklist.js`));
  for (const failure of ['release', 'export', 'assertion', 'timeout']) {
    mode = failure;
    const failed = await cli(['--origin', origin, '--timeout-ms', failure === 'timeout' ? '100' : '30000']);
    assert.notEqual(failed.code, 0, failure);
    assert.ok(failed.stderr.length, failure);
  }
  assert.equal(mutations, 0);
});
