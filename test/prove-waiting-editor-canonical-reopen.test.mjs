import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startFixture } from '../scripts/fixture-http.mjs';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
const runner='scripts/prove-waiting-editor-canonical-reopen.mjs';let outDir, manifest;
before(async()=>{outDir=temporaryDirectory('waiting-reopen-proof-');({manifest}=await buildArtifact({root:process.cwd(),outDir}));});
after(()=>rm(outDir,{recursive:true,force:true}));
function cli(origin,timeout='30000',nodeArgs=[]) {return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[...nodeArgs,runner,'--origin',origin,'--timeout-ms',timeout]);let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));});}
async function serve(mode) {
 const root=resolve(outDir,'site');
 const responses = await loadFixtureAssets({ root, manifest: new Map(manifest.files.filter(row => row.path.startsWith('js/')).map(row => ['/' + row.path, row.path])) });
 if (mode === 'missing') responses.clear();
 if (mode === 'contradiction') responses.set('/js/ui-inbox.generated.js', { contentType: 'text/javascript', body: 'document.querySelector("main").textContent="Wrong deployed behavior";' });
 if (mode === 'bytes') responses.set('/js/ui-inbox.generated.js', { contentType: 'text/javascript', body: ' '.repeat(11*1024*1024) });
 if (mode === 'assets') {
  responses.set('/js/ui-inbox.generated.js', { contentType: 'text/javascript', body: "import './asset-1.js';" });
  for (let i = 1; i <= 32; i++) responses.set(`/js/asset-${i}.js`, { contentType: 'text/javascript', body: `import './asset-${i+1}.js';` });
 }
 if (mode === 'observing-timeout') for (const [path, response] of responses) responses.set(path, { ...response, hold: 'timeout' });
 responses.set('/app-release', { contentType: 'application/json', body: JSON.stringify(mode === 'unavailable' ? {} : { service:'doctorcre-app',environment:'production',source_commit:'1'.repeat(40) }) });
 if (mode === 'timeout') for (const [path, response] of responses) responses.set(path, { ...response, hold: 'timeout' });
 const server = await startFixture({ routes: responses });
 return { origin: server.origin, close: server.close, get requests() { return server.requests.map(req => ({ method: req.method, url: req.target })); } };
}
test('exact production-proof declaration and command pass fetched fixture bytes',async()=>{
 const plan=JSON.parse(await readFile('proofs/requirements/waiting-editor-canonical-reopen.json','utf8'));
 assert.ok(plan.assertions[0].predicate.includes(`node ${runner} --origin https://app.doctorcre.com --timeout-ms 30000`));
 const server=await serve('pass');try{const result=await cli(server.origin);assert.equal(result.code,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.assertions.length,5);assert.ok(receipt.assets.length<=30);assert.ok(receipt.fetched_bytes<=10*1024*1024);assert.ok(receipt.assets.every(a=>/^[0-9a-f]{64}$/.test(a.sha256)));assert.ok(receipt.assets.some(a=>a.path==='/js/ui-inbox.generated.js'));assert.ok(server.requests.every(r=>r.method==='GET'));}finally{await server.close();}
});
for(const [mode,expected] of [['unavailable',78],['missing',78],['timeout',78],['contradiction',1],['bytes',78],['assets',78]])test(`proof ${mode} exit ${expected}`,async()=>{
 const server=await serve(mode);try{const result=await cli(server.origin,mode==='timeout'?'100':'3000');assert.equal(result.code,expected,result.stderr);assert.notEqual(result.stderr,'');}finally{await server.close();}
});

test('startup deadline closes late browser and terminates the CLI', async () => {
 const server = await serve('pass');
 const preload = `
  import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async options => {
   const browser = await launch({ ...options, timeout: 5000 });
   process.stderr.write('browser connected\\n');
   browser.on('disconnected', () => process.stderr.write('browser disconnected\\n'));
   await new Promise(resolve => setTimeout(resolve, 1100));
   return browser;
  };
 `;
 let child, watchdog;
 try {
  const result = await new Promise((resolve, reject) => {
   child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, runner, '--origin', server.origin, '--timeout-ms', '1000'], { detached: true });
   let stderr = '';
   child.stderr.on('data', chunk => stderr += chunk);
   child.on('error', reject);
   child.on('exit', code => resolve({ code, stderr }));
   watchdog = setTimeout(() => reject(Error(`CLI did not terminate after startup deadline: ${stderr}`)), 7000);
  });
  assert.equal(result.code, 78, result.stderr);
  assert.match(result.stderr, /Proof deadline exceeded/);
  assert.match(result.stderr, /browser connected/);
  assert.match(result.stderr, /browser disconnected/);
  assert.deepEqual(server.requests.map(request => request.url), ['/app-release']);
 } finally {
  clearTimeout(watchdog);
  if (child?.exitCode === null) {
   process.kill(-child.pid, 'SIGKILL');
   await new Promise(resolve => child.once('exit', resolve));
  }
  await server.close();
 }
});

test('compilation cancellation refuses synthetic startup', async () => {
 const { syntheticWaiting } = await import('../scripts/prove-waiting-editor-canonical-reopen.mjs');
 const controller = new AbortController();
 const reason = Error('Cancelled compilation');
 const compiling = syntheticWaiting(controller.signal);
 controller.abort(reason);
 await assert.rejects(compiling, error => error === reason);
});

test('observation deadline closes the browser during an asset fetch', async () => {
 const server = await serve('observing-timeout');
 const preload = `
  import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async options => {
   const browser = await launch(options);
   const newContext = browser.newContext.bind(browser);
   browser.newContext = async options => {
    const context = await newContext(options);
    context.setDefaultTimeout = () => {};
    return context;
   };
   browser.on('disconnected', () => process.stderr.write('browser disconnected\\n'));
   return browser;
  };
 `;
 try {
  const result = await cli(server.origin, '3000', ['--import', `data:text/javascript,${encodeURIComponent(preload)}`]);
  assert.equal(result.code, 78, result.stderr);
  assert.match(result.stderr, /Proof deadline exceeded/);
  assert.match(result.stderr, /browser disconnected/);
  assert.ok(server.requests.some(request => request.url === '/js/ui-inbox.generated.js'));
 } finally { await server.close(); }
});


test('independent host root probe cannot enter proof request observations', async () => {
 const server = await serve('pass');
 try {
  const probe = new Promise((resolve, reject) => {
   const child = spawn(process.execPath, ['--input-type=module', '-e',
    'const response = await fetch(process.argv[1]); await response.arrayBuffer();', server.origin + '/']);
   child.once('error', reject);
   child.once('exit', code => code === 0 ? resolve() : reject(Error(`Probe exited ${code}`)));
  });
  const [result] = await Promise.all([cli(server.origin), probe]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(server.requests.some(request => request.url === '/app-release'));
  assert.ok(server.requests.some(request => request.url === '/js/ui-inbox.generated.js'));
  assert.equal(server.requests.filter(request => request.url === '/').length, 0);
 } finally { await server.close(); }
});
