import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { uiAssets } from '../scripts/ui-bundle.mjs';

const assets = await uiAssets(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
const runner = new URL('../scripts/prove-brief-queue-menu-malformed-section.mjs', import.meta.url);
function cli(origin, timeout = '30000') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner.pathname, '--origin', origin, '--timeout-ms', timeout]);
    let output = '', error = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    child.on('error', reject);
    child.on('close', code => { try { resolve({ code, report: JSON.parse(output), error }); } catch { reject(new Error(output + error)); } });
  });
}

test('proof CLI uses declared flags, fetched bytes, bounded failures and timeout', async t => {
  let mode = 'valid';
  const fetched = [];
  const server = createServer((request, response) => {
    fetched.push(request.url);
    if (mode === 'timeout') return;
    if (request.url === '/app-release') {
      if (mode === 'release-missing') { response.writeHead(404).end(); return; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ service: 'doctorcre-app', source_commit: 'a'.repeat(40), environment: 'fixture' })); return;
    }
    if (mode === 'missing' || mode === 'chunk-missing' && request.url.includes('ui-shared-')) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', 'text/javascript');
    if (mode === 'failed') { response.end('export function createBriefQueueView(){return {renderMenu(){},dispose(){}}}'); return; }
    if (mode === 'cap') {
      const number = request.url === '/js/ui-queue.js' ? 0 : Number(request.url.match(/ui-shared-(\d+)/)[1]);
      response.end(`import './ui-shared-${number + 1}.generated.js'`); return;
    }
    if (mode === 'foreign') { response.end('import "https://example.invalid/evil.js"'); return; }
    const bytes = assets.get(request.url.slice(1));
    if (!bytes) { response.writeHead(404).end(); return; }
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [scenario, expected] of [['valid', 0], ['failed', 1], ['missing', 78], ['release-missing', 78], ['chunk-missing', 78], ['foreign', 78], ['cap', 78], ['timeout', 78]]) {
    mode = scenario;
    fetched.length = 0;
    const { code, report } = await cli(origin);
    assert.equal(code, expected, JSON.stringify(report));
    assert.ok(fetched.length <= 20);
    assert.equal(new Set(fetched).size, fetched.length, 'no retry');
    if (scenario === 'valid') {
      assert.equal(report.release.source_commit, 'a'.repeat(40));
      assert.ok(report.assertions.length > 50);
      assert.ok(report.assertions.every(result => result.passed));
      assert.deepEqual(report.assets.map(asset => new URL(asset.url).pathname), fetched);
      assert.ok(report.assets.every(asset => /^[0-9a-f]{64}$/.test(asset.sha256)));
      assert.ok(fetched.some(path => /ui-shared-/.test(path)));
      for (const asset of report.assets.slice(1)) {
        const bytes = assets.get(new URL(asset.url).pathname.slice(1));
        assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'));
      }
    }
  }
});
