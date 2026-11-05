import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
for (const mode of ['valid','missing-export','protected','sign-in','timeout','bad-coverage','wrong-release','missing-revision','stale-release']) {
  test(`deployed taxonomy CLI ${mode}`,async t=>{
    const server=createServer(async(req,res)=>{
      if (req.url === '/app-release') {
        res.setHeader('content-type','application/json');
        return res.end(JSON.stringify({service:mode==='wrong-release'?'other':'doctorcre-app',source_commit:mode==='missing-revision'?null:mode==='stale-release'?'1'.repeat(40):revision}));
      }
      if (!/^\/js\/[\w.-]+\.(m?js)$/.test(req.url)) {res.writeHead(405);return res.end();}
      if (req.url === '/js/contact-reasons.mjs') {
        if (mode==='protected') {res.writeHead(403);return res.end('protected');}
        if (mode==='sign-in') {res.setHeader('content-type','text/html');return res.end('<form>Sign in</form>');}
        if (mode==='timeout') return;
        if (mode==='missing-export') {res.setHeader('content-type','text/javascript');return res.end('export const missing = true;');}
      }
      try {
        let body=await readFile(new URL('..'+req.url,import.meta.url),'utf8');
        if(mode==='bad-coverage' && req.url==='/js/contact-reasons.mjs') body=body.replace('Object.hasOwn(sources,row.source)','sources[row.source]');
        res.setHeader('content-type','text/javascript');res.end(body);
      } catch {res.writeHead(404);res.end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>{server.closeAllConnections();server.close();});
    const origin=`http://127.0.0.1:${server.address().port}`;
    const command=['scripts/prove-contact-reasons-own-taxonomy.mjs','--origin',origin,'--required-revision',revision,'--timeout-ms',mode==='timeout'?'1000':'10000'];
    if (mode==='valid') {
      const {stdout}=await exec(process.execPath,command,{timeout:15000});
      const receipt=JSON.parse(stdout);
      assert.equal(receipt.origin,origin);
      assert.equal(receipt.release.source_commit,revision);
      assert.equal(receipt.assertions.length,4);
      assert.ok(receipt.module_urls.some(url=>url.endsWith('/js/ui-reasons.js')));
      assert.ok(receipt.requests<=40);
    } else {
      await assert.rejects(exec(process.execPath,command,{timeout:15000}),error=>{
        assert.equal(error.code,1);
        assert.match(error.stderr,/Contact taxonomy proof failed/);
        return true;
      });
    }
  });
}
