import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from './proof-fixture-server.mjs';
import {prove} from '../scripts/prove-client-anniversary-panel.mjs';
import {assertProofDeadlineCleanup} from './proof-browser-harness.mjs';
const exec=promisify(execFile), expected='a'.repeat(40);
const root=resolve(new URL('../',import.meta.url).pathname);
const fixtures=JSON.parse(await readFile(new URL('./fixtures/client-anniversary-panel/recordings.json',import.meta.url),'utf8'));
async function server(t,{commit=expected,wrong=false,state='ready',auth=false}={}) {
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
    if(url.pathname==='/app-release')return json({service:'doctorcre-app',environment:'production',source_commit:commit});
    if(url.pathname==='/auth/session') {if(auth){res.statusCode=401;return json({error:'unauthorized'});}return json({actor:{slug:'joe'},csrf_token:'synthetic'});}
    if(url.pathname==='/api/v1/intelligence/client-anniversary-read')return json(fixtures[state].output);
    if(url.pathname==='/leases'){
      res.setHeader('content-type','text/html');return res.end(`<div id="host"></div><script type="module">import {mountClientAnniversaries} from '/js/ui-client-anniversaries.js';import {createClientAnniversariesClient} from '/js/client-anniversaries-client.js';const client=createClientAnniversariesClient();mountClientAnniversaries(document.getElementById('host'),{load:async signal=>{const value=await client.read({signal});${wrong?"value.rows[0].client_name='Wrong label';":''}return value;}});</script>`);
    }
    let path;
    try{path=resolve(root,'.'+decodeURIComponent(url.pathname));}catch{res.statusCode=400;return res.end();}
    if(!path.startsWith(root+sep)){res.statusCode=403;return res.end();}
    try{res.setHeader('content-type','text/javascript');res.end(await readFile(path));}catch{res.statusCode=404;res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  return `http://127.0.0.1:${server.address().port}`;
}
test('proof CLI passes equal containing release and fails mismatched visible labels',async t=>{
  const origin=await server(t);
  const result=await exec(process.execPath,['scripts/prove-client-anniversary-panel.mjs','--origin',origin,'--expected-commit',expected,'--timeout-ms','15000']);
  assert.equal(JSON.parse(result.stdout).status,'passed');
  const wrong=await server(t,{wrong:true});
  await assert.rejects(exec(process.execPath,['scripts/prove-client-anniversary-panel.mjs','--origin',wrong,'--expected-commit',expected,'--timeout-ms','15000']),e=>e.code===1);
});
test('descendant containing release passes',async t=>{
  const origin=await server(t,{commit:'b'.repeat(40)});
  assert.equal((await prove({origin,expectedCommit:expected,ancestry:async()=>true})).status,'passed');
});
for(const kind of ['older','unrelated','unknown'])test(`${kind} release is insufficient evidence`,async t=>{
  const origin=await server(t,{commit:kind==='unknown'?'unknown':'b'.repeat(40)});
  await assert.rejects(prove({origin,expectedCommit:expected,ancestry:async()=>false}),{exitCode:78});
});
for(const options of [{state:'unavailable'},{auth:true}])test(`unavailable natural session ${JSON.stringify(options)} exits 78`,async t=>{
  const origin=await server(t,options);
  await assert.rejects(prove({origin,expectedCommit:expected,timeoutMs:1500}),{exitCode:78});
});
for(const mode of ['late launch','stalled evaluation'])test(`total deadline cleans ${mode}`,async t=>{
  const origin=await server(t);
  await assertProofDeadlineCleanup(t,{entry:'scripts/prove-client-anniversary-panel.mjs',args:['--origin',origin,'--expected-commit',expected],mode,timeoutMs:3000});
});
