import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build, transform } from 'esbuild';
import { startFixture, startWorkerFixture } from '../scripts/fixture-http.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import { appAssetSnapshot } from '../scripts/fixture-app-assets.mjs';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { chromium as rawChromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove } from '../scripts/prove-historical-close-window.mjs';

const exec = promisify(execFile);
const assets = await uiAssets(path => readFile(path));
const runner = fileURLToPath(new URL('../scripts/prove-historical-close-window.mjs',import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('recordings use pinned registered producer and exact production parser',async () => {
  const fixture = new URL('./fixtures/historical-close-window/',import.meta.url);
  const pinned = (await readFile(new URL('producer.txt',fixture),'utf8')).split('\nAPP PARSER\n');
  const provenance = JSON.parse(await readFile(new URL('provenance.json',fixture)));
  const source = await readFile(new URL('../src/ui/ideal-client-profile.tsx',import.meta.url),'utf8');
  assert.equal(pinned[1],source.split('export function mount')[0]);
  assert.equal(sha(pinned[0]),provenance.producer_sha256);
  assert.equal(sha(pinned[1]),provenance.parser_sha256);
  const parser = await transform(pinned[1].replace(/^import .*\n/gm,'')+'\nparse;', {loader:'ts'});
  const parse = vm.runInNewContext(parser.code);
  const producer = await transform('const tools={'+pinned[0]+'}; tools["ideal-client-profile"].handler;',{loader:'ts'});
  const handler = vm.runInNewContext(producer.code,{marketFilters:{}});
  const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/mcp_read_contracts/ideal-client-profile.json',import.meta.url)));
  const recordingBytes = await readFile(new URL('recordings.json',fixture));
  assert.equal(sha(recordingBytes),provenance.recordings_sha256);
  const data = JSON.parse(recordingBytes);
  for (const payload of Object.values(data)) {
    assert.equal(payload.schema_version,contract.schema_version); assert.equal(payload.coverage,contract.coverage);
    assert.ok(payload.profiles.length <= contract.limit);
    parse(payload);
    const rows = payload.profiles.map(({hypothesis,...row})=>row);
    const observed = await handler({query:async()=>({rows})},null,{});
    assert.equal(JSON.stringify(observed),JSON.stringify(payload));
  }
});

async function fixture(t, mode='equal') {
  const history = temporaryDirectory('close-window-history-',t);
  const git = async (...args) => (await exec('git',args,{cwd:history})).stdout.trim();
  await git('init');
  const commit = async name => {
    await writeFile(join(history,'revision'),name); await git('add','revision');
    await git('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m',name);
    return git('rev-parse','HEAD');
  };
  const older = await commit('older'), expected = await commit('expected'), descendant = await commit('descendant');
  await git('checkout','--orphan','unrelated'); const unrelated = await commit('unrelated');
  const released = ({older,descendant,unrelated,unknown:'f'.repeat(40)})[mode] || expected;
  const recorded = JSON.parse(await readFile(new URL('./fixtures/historical-close-window/recordings.json',import.meta.url)));
  if (mode === 'padded-label') recorded.full.profiles[0].evidence[0].deal_name = '  Dental lease 1  ';
  const snapshot = new Map([...(await appAssetSnapshot()), ...[...assets].map(([path,body])=>['/'+path,{body,contentType:'text/javascript'}])]);
  if(mode==='assertion') snapshot.set('/js/ui-ideal-client-profile.generated.js',{body:assets.get('js/ui-ideal-client-profile.generated.js').toString().replaceAll('Full-history wins','Wrong heading'),contentType:'text/javascript'});
  const mutations = {
    'date-text': ['{entry.closed_on}</time>', '1{entry.closed_on}</time>'],
    'date-value': ['dateTime={entry.closed_on}', 'dateTime={`1${entry.closed_on}`}'],
    'deal-label': ["{entry.deal_name || 'Won deal'}", "1{entry.deal_name || 'Won deal'}"],
  };
  if (mutations[mode]) {
    const source = await readFile(new URL('../src/ui/ideal-client-profile.tsx', import.meta.url), 'utf8');
    const [before, after] = mutations[mode];
    assert.ok(source.includes(before));
    const output = await build({ stdin: { contents: source.replace(before, after), loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', jsx: 'automatic' });
    snapshot.set('/js/ui-ideal-client-profile.generated.js', { body: output.outputFiles[0].contents, contentType: 'text/javascript' });
  }
  const routes = new Map([['/',{contentType:'text/html',body:`<!doctype html><title>Natural fixture</title><main></main><script type="module">
    import { mountIdealClientProfile } from '/js/ui-ideal-client-profile.generated.js';
    mountIdealClientProfile(document.querySelector('main'),{ async getIdealClientProfile(){
      const response=await fetch('/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ideal-client-profile',arguments:{}}})});
      return JSON.parse((await response.json()).result.content[0].text);
    }});
  </script>`}]]);
  if (mode === 'charts-route' || mode === 'old-route') {
    const root = temporaryDirectory('close-window-charts-', t);
    const { manifest } = await buildArtifact({ root: process.cwd(), outDir: root });
    const built = await loadFixtureAssets({ root: join(root, 'site'), manifest: new Map(manifest.files.map(row => ['/' + row.path, row.path])) });
    for (const [path, asset] of built) snapshot.set(path, asset);
    routes.clear();
    if (mode === 'old-route') routes.set('/', { status: 302, headers: { location: '/leads' } });
  }
  const session = JSON.parse(await readFile(new URL('./fixtures/fact-review-term-key-filter/recordings.json', import.meta.url))).session;
  const server = await startWorkerFixture({assets:snapshot,routes,env:{GIT_SHA:released,APP_ENV:'production',CARR:{fetch:async request=>{
    if (new URL(request.url).pathname === '/auth/session') return Response.json(session);
    if (request.method === 'GET') return new Response(null, { status: 200 });
    const input=await request.json();
    if (input.params?.name === "list-verbs") return Response.json({result:{content:[{type:"text",text:JSON.stringify(registry)}]}});
    assert.equal(input.params.name,'ideal-client-profile');
    return Response.json({jsonrpc:'2.0',id:input.id,result:{content:[{type:'text',text:JSON.stringify(mode==='empty'?recorded.empty:recorded.full)}]}});
  }}}});
  t.after(()=>server.close());
  return {origin:server.origin,expected:mode==='unknown-expected'?'e'.repeat(40):expected,history};
}
async function cli(t, mode, extra=[]) {
  const f = await fixture(t,mode);
  try { const result=await exec(process.execPath,[runner,'--origin',f.origin,'--expected-commit',f.expected,'--timeout-ms','15000',...extra],{cwd:f.history,timeout:25000}); return {code:0,receipt:JSON.parse(result.stdout)}; }
  catch(error) { return {code:error.code,receipt:JSON.parse(error.stdout)}; }
}
for (const mode of ['equal','descendant']) test(`CLI containing ${mode} release passes one-day fixture`,async t=>{
  const result=await cli(t,mode,['--fixture']); assert.equal(result.code,0,JSON.stringify(result)); assert.equal(result.receipt.observation.evidence,1);
});
for (const mode of ['older','unrelated','unknown','unknown-expected']) test(`CLI ${mode} release is insufficient evidence`,async t=>{
  const result=await cli(t,mode,['--fixture']); assert.equal(result.code,78,JSON.stringify(result));
});
test('containing release with unreachable CDP exits 78',async t=>{
  const result=await cli(t,'equal',['--cdp-url','http://127.0.0.1:1']); assert.equal(result.code,78,JSON.stringify(result));
});
test('containing release without signed-in session exits 78',async t=>{
  assert.equal((await cli(t,'equal')).code,78);
});
for (const mode of ['late launch','stalled evaluation']) test(`deadline cleans owned browser after ${mode}`,async t=>{
  const f=await fixture(t); let alive=0;
  const engine={async launch(){
    if(mode==='late launch') await new Promise(resolve=>setTimeout(resolve,150));
    alive++;
    return {close:async()=>{alive=0;},newPage:async()=>({route:async()=>{},goto:()=>new Promise(()=>{})})};
  }};
  await assert.rejects(prove({origin:f.origin,expectedCommit:f.expected,timeoutMs:70,fixture:true,engine}),{exitCode:78});
  await new Promise(resolve=>setTimeout(resolve,200)); assert.equal(alive,0);
});
test('containing release assertion failure exits 1 through CLI',async t=>{
  const result=await cli(t,'assertion',['--fixture']); assert.equal(result.code,1,JSON.stringify(result));
});
for (const mode of ['late launch','stalled evaluation']) test(`real browser is disconnected after proof ${mode}`,async t=>{
  const f=await fixture(t); let owned;
  const engine={async launch(options){
    owned=await rawChromium.launch({...options,timeout:10000,args:[...CHROMIUM_SAFETY_ARGS, ...(options.args || [])]});
    if(mode==='late launch') await new Promise(resolve=>setTimeout(resolve,1000));
    else {
      const newPage=owned.newPage.bind(owned);
      owned.newPage=async()=>{const page=await newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<title>Stall</title>'}));page.goto=()=>page.evaluate(()=>new Promise(()=>{}));return page;};
    }
    return owned;
  }};
  await assert.rejects(prove({origin:f.origin,expectedCommit:f.expected,timeoutMs:700,fixture:true,engine}),{exitCode:78});
  await new Promise(resolve=>setTimeout(resolve,1400)); assert.ok(owned); assert.equal(owned.isConnected(),false);
});

test('signed-in natural fixture passes normalized deal labels while borrowed browser survives',async t=>{
  const f=await fixture(t,'padded-label');
  const socket=await startFixture();
  const port=new URL(socket.origin).port; await socket.close();
  const borrowed=await rawChromium.launch({args:[...CHROMIUM_SAFETY_ARGS,`--remote-debugging-port=${port}`]});
  t.after(()=>borrowed.close());
  const context=await borrowed.newContext(); const keeper=await context.newPage();
  const result=await prove({origin:f.origin,expectedCommit:f.expected,cdpUrl:`http://127.0.0.1:${port}`,timeoutMs:15000});
  assert.equal(result.status,'passed'); assert.equal(borrowed.isConnected(),true); assert.equal(keeper.isClosed(),false);
  const empty=await fixture(t,'empty');
  await assert.rejects(prove({origin:empty.origin,expectedCommit:empty.expected,cdpUrl:`http://127.0.0.1:${port}`,timeoutMs:1200}),{exitCode:78});
  assert.equal(borrowed.isConnected(),true); assert.equal(keeper.isClosed(),false);
});

for (const mode of ['date-text', 'date-value', 'deal-label']) test(`CLI refuses near-miss evidence ${mode}`, async t => {
  const result = await cli(t, mode, ['--fixture']);
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.receipt.status, 'assertion_failure');
});

for (const mode of ['connect', 'newPage']) test(`rejected CDP ${mode} acquisition is insufficient evidence`, async t => {
  const f = await fixture(t);
  let disconnected = false;
  const engine = { async connectOverCDP() {
    if (mode === 'connect') throw Error('Connection rejected');
    return { contexts: () => [{ newPage: async () => { throw Error('Page rejected'); } }], close: async () => { disconnected = true; } };
  } };
  await assert.rejects(prove({ origin: f.origin, expectedCommit: f.expected, cdpUrl: 'http://127.0.0.1:1', engine }), { exitCode: 78 });
  assert.equal(disconnected, mode === 'newPage');
});

test('late borrowed CDP page closes before disconnect, preserving existing tabs', async t => {
  const f = await fixture(t);
  const socket = await startFixture();
  const endpoint = socket.origin, port = new URL(endpoint).port;
  await socket.close();
  const borrowed = await rawChromium.launch({ args: [...CHROMIUM_SAFETY_ARGS, `--remote-debugging-port=${port}`] });
  t.after(() => borrowed.close());
  const keeper = await borrowed.newPage();
  await keeper.setContent('<title>Existing signed-in tab</title>');
  const before = await rawChromium.connectOverCDP(endpoint);
  const count = before.contexts()[0].pages().length;
  await before.close();
  let acquired = false;
  const engine = { async connectOverCDP(...args) {
    const connection = await rawChromium.connectOverCDP(...args);
    const context = connection.contexts()[0], newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      acquired = true;
      await new Promise(resolve => setTimeout(resolve, 1000));
      return page;
    };
    return connection;
  } };
  await assert.rejects(prove({ origin: f.origin, expectedCommit: f.expected, cdpUrl: endpoint, timeoutMs: 700, engine }), { exitCode: 78 });
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(acquired, true);
  const fresh = await rawChromium.connectOverCDP(endpoint);
  try {
    assert.equal(fresh.contexts()[0].pages().length, count, 'no proof-owned tab survives through fresh CDP connection');
    assert.equal(await fresh.contexts()[0].pages()[0].title(), 'Existing signed-in tab');
  } finally { await fresh.close(); }
  assert.equal(borrowed.isConnected(), true);
  assert.equal(keeper.isClosed(), false);
});

for (const mode of ['charts-route', 'old-route']) test(`CLI verifies real charts wiring against ${mode}`, async t => {
  const f = await fixture(t, mode);
  const socket = await startFixture();
  const endpoint = socket.origin, port = new URL(endpoint).port;
  await socket.close();
  const browser = await rawChromium.launch({ args: [...CHROMIUM_SAFETY_ARGS, `--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  const setup = await rawChromium.connectOverCDP(endpoint);
  t.after(() => setup.close());
  const context = setup.contexts()[0];
  await context.addInitScript(() => {
    const url = new URL(location.href);
    url.searchParams.set('mode', 'live');
    history.replaceState(null, '', url);
  });
  let result;
  try {
    const output = await exec(process.execPath, [runner, '--origin', f.origin, '--expected-commit', f.expected, '--cdp-url', endpoint, '--timeout-ms', '15000'], { cwd: f.history, timeout: 25000 });
    result = { code: 0, receipt: JSON.parse(output.stdout) };
  } catch (error) { result = { code: error.code, receipt: JSON.parse(error.stdout) }; }
  assert.equal(result.code, mode === 'charts-route' ? 0 : 1, JSON.stringify(result));
  assert.equal(result.receipt.status, mode === 'charts-route' ? 'passed' : 'assertion_failure');
  if (mode === 'charts-route') assert.equal(result.receipt.observation.evidence, 1);
});

const registry = JSON.parse(await readFile(new URL("./fixtures/walk-verb-registry.json", import.meta.url))).response;

for (const mode of ['extra read', 'future read', 'write', 'unknown', 'unreadable', 'malformed', 'incomplete', 'empty', 'cleanup write', 'cleanup unknown']) test(`registry CLI ${mode}`, async t => {
  const f = await fixture(t, 'equal');
  const scratch = temporaryDirectory('registry-cli-', t);
  const preload = join(scratch, 'preload.mjs');
  const marker = join(scratch, 'forwarded');
  const live = structuredClone(registry);
  live.verbs.push({ name: 'future-proof-read', write: false }); live.count++;
  const name = mode.endsWith('write') ? live.verbs.find(row => row.write).name : mode.endsWith('unknown') ? 'unregistered-proof-call' : mode === 'future read' ? 'future-proof-read' : 'read-doctrine';
  if (mode === 'malformed') delete live.verbs[0].write;
  if (mode === 'incomplete') live.count++;
  if (mode === 'empty') { live.verbs = []; live.count = 0; }
  await writeFile(preload, `
    import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
    import { appendFile } from 'node:fs/promises';
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (...args) => {
      const connection = await connect(...args), context = connection.contexts()[0];
      await context.route('**/mcp', async route => {
        const call = route.request().postDataJSON().params;
        if (call.name === 'list-verbs') {
          await appendFile(${JSON.stringify(marker + '.registry')}, '1');
          if (call.arguments.names_only !== true) throw Error('names_only registry required');
          if (${JSON.stringify(mode)} === 'unreadable') return route.fulfill({status:503,body:'Unavailable'});
          return route.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(${JSON.stringify(live)})}]}}});
        }
        if (call.name === ${JSON.stringify(name)}) {
          await appendFile(${JSON.stringify(marker)}, call.name);
          return route.fulfill({json:{result:{content:[{type:'text',text:'{}'}]}}});
        }
        return route.fallback();
      });
      if (${JSON.stringify(mode)}.startsWith('cleanup')) {
        const newPage = context.newPage.bind(context);
        context.newPage = async (...args) => {
          const page = await newPage(...args), close = page.close.bind(page);
          page.close = async (...options) => {
            await page.evaluate(async name => {
              await fetch('/mcp', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:91,method:'tools/call',params:{name,arguments:{}}})}).catch(() => {});
            }, ${JSON.stringify(name)}).catch(() => {});
            return close(...options);
          };
          return page;
        };
      }
      await context.addInitScript(({name, cleanup}) => {
        if (cleanup) return;
        document.addEventListener('DOMContentLoaded', () => {
          void fetch('/mcp', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:90,method:'tools/call',params:{name,arguments:{}}})}).catch(() => {});
        });
      }, {name: ${JSON.stringify(name)}, cleanup: ${JSON.stringify(mode)}.startsWith('cleanup')});
      return connection;
    };
  `);
  const listener = await startFixture();
  const port = new URL(listener.origin).port; await listener.close();
  const { chromium: owner } = await import('../scripts/proof-browser.mjs');
  const browser = await owner.launch({args:[...CHROMIUM_SAFETY_ARGS, `--remote-debugging-port=${port}`]});
  t.after(() => browser.close());
  const cliArgs = ['--import', preload, 'scripts/prove-historical-close-window.mjs', '--origin', f.origin, '--expected-commit', f.expected, '--cdp-url', `http://127.0.0.1:${port}`];
  const execution = promisify(execFile)(process.execPath, cliArgs);
  if (['extra read', 'future read'].includes(mode)) {
    assert.equal(JSON.parse((await execution).stdout).status, 'passed');
    assert.equal(await readFile(marker, 'utf8'), name);
  } else {
    await assert.rejects(execution, error => {
      assert.equal(error.code, mode.endsWith('write') ? 1 : 78, error.stdout);
      return true;
    });
    await assert.rejects(readFile(marker), {code:'ENOENT'});
  }
  assert.equal(await readFile(marker + '.registry', 'utf8'), '1', 'one registry read');
  assert.ok(browser.isConnected());
});
