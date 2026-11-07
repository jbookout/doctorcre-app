import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createServer } from './proof-fixture-server.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove, requireContainingRelease, signedInEngine } from '../scripts/prove-terms-expense-basis.mjs';
const exec = promisify(execFile);
const commit = '1'.repeat(40);
const records = JSON.parse(readFileSync(new URL('./fixtures/terms-expense-basis/recordings.json', import.meta.url))).records;

async function fixture(t, { broken = false, sourceCommit = commit } = {}) {
  const root = resolve(new URL('../', import.meta.url).pathname);
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/app-release') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: sourceCommit })); }
    if (path === '/mcp') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(records.full.response) }] } })); }
    if (path === '/deals') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<button class="kanban-card" data-id="synthetic-a">Synthetic deal</button><main id="workspace-market-terms"></main><script type="module">import {mountMarketTerms} from '/js/ui-market.js'; mountMarketTerms(document.querySelector('main'), {entityRef:'synthetic-a',client:{readMarketTerms:async()=>{const e=await (await fetch('/mcp',{method:'POST',body:JSON.stringify({params:{name:'read-market-terms'}})})).json();const data=JSON.parse(e.result.content[0].text);${broken ? "data.rows=data.rows.slice(0,1);" : ''}return data;}}});</script>`);
    }
    try {
      const file = resolve(root, '.' + decodeURIComponent(path));
      if (!file.startsWith(root + sep)) { res.statusCode = 403; return res.end(); }
      res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('release containment accepts equal and descendant and refuses older unrelated and unknown without historical objects', async t => {
  const cwd = temporaryDirectory('basis-ancestry-', t);
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Synthetic test']);
  await writeFile(cwd + '/fixture', 'first'); git(['add', 'fixture']); git(['commit', '-m', 'first']); const first = git(['rev-parse', 'HEAD']);
  await writeFile(cwd + '/fixture', 'second'); git(['add', 'fixture']); git(['commit', '-m', 'second']); const second = git(['rev-parse', 'HEAD']);
  git(['checkout', '--orphan', 'unrelated']); git(['commit', '-m', 'other']); const other = git(['rev-parse', 'HEAD']);
  await requireContainingRelease(first, first, { cwd });
  await requireContainingRelease(first, second, { cwd });
  for (const observed of [first, other, 'f'.repeat(40)]) await assert.rejects(requireContainingRelease(second, observed, { cwd }), { exitCode: 78 });
});

for (const broken of [false, true]) test(`containing release fixture exercises production observation, broken=${broken}`, async t => {
  const origin = await fixture(t, { broken });
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    const engine = { launch: async () => browser };
    if (broken) await assert.rejects(prove({ origin, expectedCommit: commit, engine }), error => error.exitCode !== 78);
    else assert.equal((await prove({ origin, expectedCommit: commit, engine })).status, 'passed');
  } finally { await browser.close(); }
});

test('unreachable CDP with containing release exits 78 through CLI', async t => {
  const origin = await fixture(t);
  await assert.rejects(exec(process.execPath, ['scripts/prove-terms-expense-basis.mjs', '--origin', origin, '--expected-commit', commit, '--cdp-url', 'http://127.0.0.1:1', '--timeout-ms', '2000']), error => error.code === 78 && /insufficient_evidence/.test(error.stdout));
});

for (const mode of ['late launch', 'stalled evaluation']) test(`total proof deadline disposes owned browser after ${mode}`, async t => {
  const origin = await fixture(t);
  let acquired;
  const engine = { async launch(options) {
    acquired = await chromium.launch({ ...options, timeout: 10000, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] });
    if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 1200));
    else { const newPage = acquired.newPage.bind(acquired); acquired.newPage = async () => { const page = await newPage(); page.goto = () => page.evaluate(() => new Promise(() => {})); return page; }; }
    return acquired;
  } };
  await assert.rejects(prove({ origin, expectedCommit: commit, timeoutMs: 1000, engine }), { exitCode: 78 });
  const until = Date.now() + 12000;
  while ((!acquired || acquired.isConnected()) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(acquired); assert.equal(acquired.isConnected(), false);
});

test('borrowed browser remains connected and late owned page closes', async () => {
  let finish, closed = 0, browserClosed = 0;
  const engine = signedInEngine('http://127.0.0.1:9222', { connectOverCDP: async () => ({ close() { browserClosed++; }, contexts: () => [{ newPage: () => new Promise(resolve => { finish = resolve; }) }] }) });
  const browser = await engine.launch({ args: [...CHROMIUM_SAFETY_ARGS], timeout: 1000 });
  const pending = browser.newPage(); await browser.close(); finish({ close: async () => { closed++; } });
  await assert.rejects(pending, { exitCode: 78 });
  assert.equal(closed, 1); assert.equal(browserClosed, 1);
});

for (const broken of [false, true]) test(`CLI fixture exits ${broken ? 1 : 0} and disconnects borrowed browser`, async t => {
  const origin = await fixture(t, { broken });
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS, `--remote-debugging-port=${port}`] });
  try {
    const args = ['scripts/prove-terms-expense-basis.mjs', '--origin', origin, '--expected-commit', commit, '--cdp-url', `http://127.0.0.1:${port}`, '--timeout-ms', '5000'];
    if (broken) await assert.rejects(exec(process.execPath, args, { timeout: 10000 }), error => error.code === 1 && /assertion_failure/.test(error.stdout));
    else assert.match((await exec(process.execPath, args, { timeout: 10000 })).stdout, /"status":"passed"/);
    assert.equal(browser.isConnected(), true);
    const page = await browser.newPage(); await page.close();
  } finally { await browser.close(); }
});

test('closed browser and missing signed-in context are insufficient evidence', async t => {
  const origin = await fixture(t);
  await assert.rejects(prove({ origin, expectedCommit: commit, engine: { launch: async () => { throw Error('Browser has been closed'); } } }), { exitCode: 78 });
  let disconnected = false;
  const engine = signedInEngine('http://127.0.0.1:9222', { connectOverCDP: async () => ({ contexts: () => [], close: async () => { disconnected = true; } }) });
  await assert.rejects(prove({ origin, expectedCommit: commit, engine }), { exitCode: 78 });
  assert.equal(disconnected, true);
});
