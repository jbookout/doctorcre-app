import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const snapshot = await proofAssetSnapshot();
for (const [key,value] of await loadFixtureAssets({root:process.cwd(),manifest:new Map([['/js/contact-reasons.mjs','js/contact-reasons.mjs']])})) snapshot.set(key,value);
for (const mode of ['valid','missing-export','protected','sign-in','timeout','bad-coverage','wrong-release','missing-revision','stale-release']) {
  test(`deployed taxonomy CLI ${mode}`,async t=>{
    const routes = new Map(snapshot);
    routes.set('/app-release', { contentType: 'application/json', body: JSON.stringify({service:mode==='wrong-release'?'other':'doctorcre-app',environment:'production',source_commit:mode==='missing-revision'?null:mode==='stale-release'?'1'.repeat(40):revision}) });
    const key = '/js/contact-reasons.mjs';
    if (mode === 'protected') routes.set(key, { status: 403, body: 'protected' });
    if (mode === 'sign-in') routes.set(key, { contentType: 'text/html', body: '<form>Sign in</form>' });
    if (mode === 'timeout') routes.set(key, { hold: 'timeout' });
    if (mode === 'missing-export') routes.set(key, { contentType: 'text/javascript', body: 'export const missing = true;' });
    if (mode === 'bad-coverage') {
      const source = routes.get(key).body.toString();
      const body = source.replace('Object.hasOwn(sources,row.source)','sources[row.source]');
      assert.notEqual(body,source,'negative fixture removes own-source admission');
      routes.set(key,{...routes.get(key),body});
    }
    const server = await startFixture({ routes });
    t.after(() => server.close());
    const origin = server.origin;
    const command=['scripts/prove-contact-reasons-own-taxonomy.mjs','--origin',origin,'--required-revision',revision,'--timeout-ms',mode==='timeout'?'1000':'10000'];
    if (mode==='valid') {
      const {stdout}=await exec(process.execPath,command,{timeout:15000});
      const receipt=JSON.parse(stdout);
      assert.equal(receipt.origin,origin);
      assert.equal(receipt.release.source_commit,revision);
      assert.equal(receipt.assertions.length,7);
      assert.ok(receipt.module_urls.some(url=>url.endsWith('/js/ui-reasons.generated.js')));
      assert.ok(receipt.requests<=40);
    } else {
      await assert.rejects(exec(process.execPath,command,{timeout:15000}),error=>{
        assert.equal(error.code,['wrong-release','missing-revision'].includes(mode)?78:1);
        assert.match(error.stderr,/Contact taxonomy proof failed/);
        return true;
      });
    }
  });
}
