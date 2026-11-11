import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { uiAssets } from '../scripts/ui-bundle.mjs';
const execute = promisify(execFile);
const release = {service:'doctorcre-app',source_commit:'46bea5d02a9618952c48434a534af8d339de93e9',environment:'production'};
const assets = await uiAssets(path=>readFile(path));
const renderer = await readFile('src/ui/answer-blocks.tsx','utf8');
const before = renderer.replace(/\{chart.kind === 'line' && segments\.map\([^\n]+/,"{chart.kind === 'line' && <polyline fill=\"none\" stroke=\"currentColor\" points={points.map(p => `${x(p.index)},${y(p.value)}`).join(' ')} />}");
assert.notEqual(before,renderer,'broken fixture restores the pre-fix joined line');
const broken = await uiAssets(path=>path === 'src/ui/answer-blocks.tsx' ? before : readFile(path));

async function fixture(t, mode) {
  const responses = new Map();
  const fixtureAssets = mode === 'broken' ? broken : assets;
  for (const [path, original] of fixtureAssets) {
    let body = original;
    if (mode === 'no-entry' || mode === 'no-chunk' && path !== 'js/ui-answers.generated.js') continue;
    if (mode === 'foreign') body = 'import "https://example.invalid/foreign.js";';
    responses.set('/' + path, { body, contentType: 'text/javascript' });
  }
  if (mode === 'cap') {
    responses.set('/js/ui-answers.generated.js', { body: 'import "./ui-shared-1.generated.js";', contentType: 'text/javascript' });
    for (let i = 1; i <= 20; i++) responses.set(`/js/ui-shared-${i}.generated.js`, { body: `import "./ui-shared-${i+1}.generated.js";`, contentType: 'text/javascript' });
  }
  responses.set('/app-release', { status: mode === 'no-release' ? 404 : 200, contentType: 'application/json', body: JSON.stringify(mode === 'invalid-release' ? {} : release) });
  if (mode === 'timeout') for (const [path, response] of responses) responses.set(path, { ...response, hold: 'timeout' });
  const server = await startFixture({ routes: responses });
  t.after(() => server.close());
  return { origin: server.origin, get requests() { return server.requests.map(req => req.target); } };
}

for (const [mode,code] of [['success',0],['broken',1],['no-release',78],['invalid-release',78],['no-entry',78],['no-chunk',78],['foreign',78],['cap',78],['timeout',78]]) {
  test(`proof CLI ${mode} with declared flags`,{timeout:40000},async t=>{
    const fixtureServer = await fixture(t,mode), origin = fixtureServer.origin;
    let result;
    try {result = {code:0,...await execute(process.execPath,['scripts/prove-answer-chart-missing-value-gaps.mjs','--origin',origin,'--timeout-ms','30000'],{timeout:35000})};}
    catch(error) {result = error;}
    const requests = fixtureServer.requests;
    assert.equal(result.code,code,result.stdout || result.message);
    assert.equal(new Set(requests).size,requests.length,'no retries');
    assert.ok(requests.length <= 20,'finite fetch cap');
    const output = JSON.parse(result.stdout);
    if (mode === 'success') {
      assert.deepEqual(output.release,release);
      assert.ok(output.assertions.every(item=>item.passed));
      assert.equal(output.assertions.length,11);
      assert.deepEqual(output.assets.map(item=>item.path),requests);
      for (const asset of output.assets) {
        const bytes = asset.path === '/app-release' ? Buffer.from(JSON.stringify(release)) : assets.get(asset.path.slice(1));
        assert.equal(asset.sha256,createHash('sha256').update(bytes).digest('hex'));
      }
    } else assert.ok(output.error);
    if (mode === 'broken') assert.match(output.error,/interior/);
    if (mode === 'timeout') assert.match(output.error,/deadline/);
  });
}
