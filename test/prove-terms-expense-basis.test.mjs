import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
export const browserCases = [];
function test(name, run) { browserCases.push([name, run]); }
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { startFixture, startWorkerFixture } from '../scripts/fixture-http.mjs';
import { appAssetSnapshot } from '../scripts/fixture-app-assets.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove, requireContainingRelease, signedInEngine } from '../scripts/prove-terms-expense-basis.mjs';
const exec = promisify(execFile);
const commit = '1'.repeat(40);
const records = JSON.parse(readFileSync(new URL('./fixtures/terms-expense-basis/recordings.json', import.meta.url))).records;

const assets = await appAssetSnapshot();

async function fixture(t, { broken = false, nearMiss = false, localRead = false, sourceCommit = commit } = {}) {
  const server = await startWorkerFixture({
    assets,
    routes: new Map([['/deals', { contentType: 'text/html', body: `<button class="kanban-card" data-id="synthetic-a">Synthetic deal</button><main id="workspace-market-terms"></main><script type="module">import {mountMarketTerms} from '/js/ui-market.generated.js'; import {createLiveClient} from '/js/live-client.js'; const client=createLiveClient({fetchImpl:async(...args)=>{const response=await fetch(...args);${broken ? "const data=await response.json();data.rows=data.rows.slice(0,1);return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});" : 'return response;'}}}); mountMarketTerms(document.querySelector('main'), {entityRef:'synthetic-a',client});${localRead ? "document.querySelector('main').addEventListener('change',()=>fetch('/api/v1/market-terms/read',{method:'POST',body:'{}'}));" : ''}${nearMiss ? `new MutationObserver(()=>{for(const e of document.querySelectorAll('p>strong')){if(${nearMiss === 'selected' ? '/^1 matching loaded/' : '/^6 matching loaded/'}.test(e.textContent))e.firstChild.data='1'+e.firstChild.data;}}).observe(document.querySelector('main'),{childList:true,subtree:true});` : ''}</script>` }]]),
    env: {
      APP_ENV: 'production', GIT_SHA: sourceCommit,
      CARR: { fetch: async request => new URL(request.url).pathname === '/api/v1/market-terms/read'
        ? Response.json(records.full.response) : new Response('signed in') },
    },
  });
  t.after(() => server.close());
  return server.origin;
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
  const pending = browser.newPage(); const closing = browser.close(); finish({ close: async () => { closed++; } });
  await assert.rejects(pending, { exitCode: 78 }); await closing; await browser.close();
  assert.equal(closed, 1); assert.equal(browserClosed, 1);
});

for (const broken of [false, true]) test(`CLI fixture exits ${broken ? 1 : 0} and disconnects borrowed browser`, async t => {
  const origin = await fixture(t, { broken });

  const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
  const browser = browserFixture.browser;
  try {
    const args = ['scripts/prove-terms-expense-basis.mjs', '--origin', origin, '--expected-commit', commit, '--cdp-url', browserFixture.endpoint, '--timeout-ms', '5000'];
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

for (const nearMiss of [false, 'baseline', 'selected', 'local-read']) test(`real typed transport CLI compares complete displayed counts, nearMiss=${nearMiss}`, async t => {
  const origin = await fixture(t, { nearMiss: nearMiss === 'local-read' ? false : nearMiss, localRead: nearMiss === 'local-read' });

  const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
  const browser = browserFixture.browser;
  try {
    const args = ['scripts/prove-terms-expense-basis.mjs', '--origin', origin, '--expected-commit', commit, '--cdp-url', browserFixture.endpoint, '--timeout-ms', '3000'];
    if (nearMiss) await assert.rejects(exec(process.execPath, args), error => error.code === 1 && /assertion_failure/.test(error.stdout));
    else assert.equal(JSON.parse((await exec(process.execPath, args)).stdout).status, 'passed');
  } finally { await browser.close(); }
});

test('deadline drains a late real CDP page before disconnect and preserves sentinel tabs', async t => {
  const origin = await fixture(t);

  const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
  const browser = browserFixture.browser;
  const endpoint = browserFixture.endpoint;
  try {
    const initial = await chromium.connectOverCDP(endpoint);
    const sentinel = await initial.contexts()[0].newPage();
    const before = initial.contexts()[0].pages().length;
    let acquired, releasePage;
    const ready = new Promise(resolve => { acquired = resolve; });
    const engine = signedInEngine(endpoint, { async connectOverCDP(...args) {
      const connection = await chromium.connectOverCDP(...args);
      const context = connection.contexts()[0], newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        await new Promise(resolve => { releasePage = resolve; acquired(); });
        return page;
      };
      return connection;
    } });
    const result = assert.rejects(prove({ origin, expectedCommit: commit, engine, timeoutMs: 1500 }), { exitCode: 78 });
    await ready;
    await new Promise(resolve => setTimeout(resolve, 1800));
    releasePage();
    await result;
    const fresh = await chromium.connectOverCDP(endpoint);
    assert.equal(fresh.contexts()[0].pages().length, before);
    assert.equal(sentinel.isClosed(), false);
    assert.equal(browser.isConnected(), true);
    await fresh.close(); await initial.close();
  } finally { await browser.close(); }
});

test('newPage rejection on a containing release is insufficient evidence', async t => {
  const origin = await fixture(t);
  let disconnected = false;
  const engine = signedInEngine('http://127.0.0.1:9222', { connectOverCDP: async () => ({ contexts: () => [{ newPage: async () => { throw Error('Target closed'); } }], close: async () => { disconnected = true; } }) });
  await assert.rejects(prove({ origin, expectedCommit: commit, engine }), { exitCode: 78 });
  assert.equal(disconnected, true);
});
