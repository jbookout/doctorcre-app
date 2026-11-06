import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from './proof-fixture-server.mjs';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
const exec = promisify(execFile);
const script = 'scripts/prove-quick-add-draft-date-integrity.mjs';

test('proof CLI help and invalid arguments fail closed', async () => {
  assert.match((await exec(process.execPath, [script, '--help'])).stdout, /--origin/);
  for (const args of [[], ['--origin', 'bad'], ['--origin', 'ftp://example.com'], ['--origin', 'http://127.0.0.1:1', '--timeout-ms', '0']]) {
    await assert.rejects(exec(process.execPath, [script, ...args]));
  }
});

test('proof declaration command runs deployed module assertions against fixture', async t => {
  const upstream = await startFixtureServer();
  t.after(upstream.stop);
  const proxy = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/app-release') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) })); }
    const response = await fetch(upstream.url + req.url);
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || '' }); res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const server = { url: `http://127.0.0.1:${proxy.address().port}`, stop: () => { proxy.closeAllConnections(); proxy.close(); } };
  t.after(server.stop);
  const { stdout } = await exec(process.execPath, [script, '--origin', server.url, '--timeout-ms', '30000']);
  await writeFile('/tmp/WR617.S18.J1-proof-receipt.json', stdout);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.origin, server.url);
  assert.equal(receipt.assertions.length, 3);
  assert.ok(receipt.loaded_module_urls.includes(`${server.url}/js/local-drafts.mjs`));
  await assert.rejects(exec(process.execPath, [script, '--origin', server.url, '--timeout-ms', '1']));
});

for (const failure of ['release', 'export', 'assertion']) test(`proof fails closed for ${failure}`, async t => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/app-release') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(failure === 'release' ? {} : { service: 'doctorcre-app', environment: 'production', source_commit: 'a'.repeat(40) }));
    } else {
      response.setHeader('content-type', 'text/javascript');
      response.end(failure === 'export' ? 'export const missing = true;' : 'export function createLocalDrafts() { return { save: () => ({}) }; }');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(exec(process.execPath, [script, '--origin', `http://127.0.0.1:${server.address().port}`, '--timeout-ms', '30000']), error => {
    assert.match(error.stderr, /Missing app release identity|Missing createLocalDrafts export|Impossible new date accepted/);
    return true;
  });
});
