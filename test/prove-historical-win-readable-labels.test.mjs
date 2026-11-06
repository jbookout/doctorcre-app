import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import { createServer } from './proof-fixture-server.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

const runner = 'scripts/prove-historical-win-readable-labels.mjs';
function cli(args, imports = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...imports, runner, ...args], { stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
test('proof CLI passes fixtures, detects contradiction and reports insufficient evidence', async t => {
  const fixture = await startFixtureServer(); t.after(() => fixture.stop());
  const root = resolve('.'); let broken = false, protectedAsset = false;
  const server = createServer(async (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400); return res.end(); }
    if (!resolve(root, `.${pathname}`).startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    if (pathname === '/app-release') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: 'a'.repeat(40) }));
    }
    if (protectedAsset && pathname === '/js/ui-ideal-client-profile.js') { res.writeHead(403); return res.end(); }
    if (broken && pathname === '/js/ui-ideal-client-profile.js') {
      res.setHeader('content-type', 'text/javascript'); return res.end('export function mountIdealClientProfile(){throw Error("assertion fixture contradiction")}');
    }
    const upstream = await fetch(`${fixture.url}${pathname}`);
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') }); res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`, args = ['--origin', origin, '--timeout-ms', '30000'];
  const passing = await cli([...args, '--fixture']); assert.equal(passing.code, 0, passing.stderr);
  assert.equal(JSON.parse(passing.stdout).assertions.length, 7);
  const insufficient = await cli(args); assert.equal(insufficient.code, 78, insufficient.stderr);
  assert.equal(JSON.parse(insufficient.stdout).status, 'insufficient_evidence');
  broken = true; const failed = await cli([...args, '--fixture']); assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stderr, /contradiction/);
  for (const path of ['/..%2foutside', '/%2e%2e%2foutside']) assert.equal((await fetch(origin + path)).status, 403);
  broken = false; protectedAsset = true;
  const protectedResult = await cli(args); assert.equal(protectedResult.code, 78, protectedResult.stderr);
  protectedAsset = false;
  for (const mode of ['stalled evaluation', 'late launch']) {
    const scratch = temporaryDirectory('labels-proof-timeout-');
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const pidFile = join(scratch, 'owned-pids.json');
    const injection = `import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
      import { writeFileSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      const original = chromium.launch.bind(chromium);
      chromium.launch = async options => {
        const browser = await original({...options,timeout:30000});
        const owned = [];
        const walk = pid => { for (const row of execFileSync('ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\\n')) { const [child,parent]=row.trim().split(/\\s+/).map(Number); if(parent===pid){owned.push(child);walk(child);} } };
        walk(process.pid); writeFileSync(${JSON.stringify(pidFile)},JSON.stringify(owned));
        ${mode === 'late launch' ? "await new Promise(resolve=>setTimeout(resolve,1500));" : `const nc=browser.newContext.bind(browser); browser.newContext=async (...args)=>{const context=await nc(...args);const np=context.newPage.bind(context);context.newPage=async (...args)=>{const page=await np(...args);page.evaluate=()=>new Promise(()=>{});return page;};return context;};`}
        return browser;
      };`;
    const result = await cli(['--origin', origin, '--timeout-ms', '1000'], ['--import', `data:text/javascript,${encodeURIComponent(injection)}`]);
    assert.equal(result.code, 78, `${mode} ${result.stderr}`);
    const pids = JSON.parse(await readFile(pidFile, 'utf8'));
    assert.ok(pids.length > 0, 'probe acquired browser processes');
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), `${mode} leaked owned PID ${pid}`);
  }
});
