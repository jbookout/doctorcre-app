import { unreachableCdpEndpoint } from "./unreachable-cdp-fixture.ts";
import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
export const browserCases = [];
function test(name, run) { browserCases.push([name, run]); }
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '../scripts/proof-browser.mjs';
import { startWorkerFixture } from '../scripts/fixture-http.mjs';
import { appAssetSnapshot } from '../scripts/fixture-app-assets.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { validateLeadWorkspace, validateLeadDetail } from '../js/leads-client.js';
import { prove } from '../scripts/prove-research-attention.mjs';
const recording = JSON.parse(await readFile(new URL('./fixtures/research-attention/recordings.json', import.meta.url)));
validateLeadWorkspace(recording); validateLeadDetail(recording.detail, recording.detail.id);
const assets = await appAssetSnapshot();
async function fixture(t, mode) {
  const history = temporaryDirectory('research-attention-history-', t);
  const git = (...args) => execFileSync('git', args, { cwd: history, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git('init');
  const commit = async text => { await writeFile(resolve(history, 'revision'), text); git('add', 'revision'); git('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m',text); return git('rev-parse','HEAD'); };
  const older = await commit('older'), expectedCommit = await commit('expected'), descendant = await commit('descendant');
  git('checkout','--orphan','unrelated'); const unrelated = await commit('unrelated');
  const released = { older, descendant, unrelated, unknown: 'f'.repeat(40) }[mode] || expectedCommit;
  const snapshot = new Map([...assets].map(([path, value]) => [path, {
    ...value, body: mode.includes('failure') && path === '/js/ui-lead-research.generated.js'
      ? value.body.toString().replaceAll('data-flag-id', 'data-wrong-id') : value.body,
  }]));
  const server = await startWorkerFixture({ assets: snapshot, env: {
    APP_ENV: 'production', GIT_SHA: released,
    CARR: { fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === '/mcp') {
        const body = await request.json();
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text:
          JSON.stringify(body.params?.name === 'lead-board' ? recording : { error: 'fixture_read_unavailable' }),
        }] } });
      }
      return Response.json({ actor: { slug: 'example-partner' }, csrf_token: 'synthetic-test-token' });
    } },
  } });
  t.after(() => server.close());
  if (mode.startsWith('changing')) {
    const original = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      if (new URL(args[0]).pathname !== '/app-release' || ++reads === 1) return response;
      const release = await response.json();
      return Response.json({ ...release, source_commit: descendant });
    };
    t.after(() => { globalThis.fetch = original; });
  }
  return { origin: server.origin, expectedCommit, ancestryCwd: history };
}
for (const mode of ['equal','descendant','older','unrelated','unknown','failure','session','changing','changing failure']) test(`proof ${mode}`, async t => {
  const options=await fixture(t,mode);
  if (['older','unrelated','unknown','session'].includes(mode)) {
    await assert.rejects(prove(options), error=>error.exitCode===78);return;
  }
  if (mode === 'equal' || mode === 'failure') {

    const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
    const browser = browserFixture.browser;
    t.after(() => browser.close());
    const args = ['scripts/prove-research-attention.mjs', '--origin', options.origin, '--expected-commit', options.expectedCommit, '--cdp-url', browserFixture.endpoint];
    if (mode === 'failure') await assert.rejects(promisify(execFile)(process.execPath, args), error => {
      console.log(`CLI failure exit ${error.code} ${error.stdout.trim()}`);
      return error.code === 1;
    });
    else {
      const { stdout } = await promisify(execFile)(process.execPath, args);
      console.log(`CLI pass exit 0 ${stdout.trim()}`);
      assert.equal(JSON.parse(stdout).status, 'passed');
    }
    assert.ok(browser.isConnected(), 'proof disconnect preserves acquired test browser');
    assert.equal((await browser.newContext()).pages().length, 0);
    return;
  }
  const browser=await chromium.launch(); t.after(()=>browser.close());
  await browser.newContext();
  const engine={connectOverCDP:async()=>browser};
  if (mode.startsWith('changing')) await assert.rejects(prove({...options,engine,cdpUrl:'fixture'}), error => error.exitCode === 78);
  else assert.equal((await prove({...options,engine,cdpUrl:'fixture'})).status,'passed');
});
for(const mode of ['late connection','stalled evaluation']) test(`proof deadline cleans ${mode}`,async t=>{
  const options=await fixture(t,'equal');let closed=0,pageClosed=0;
  const page={setDefaultTimeout(){},route:async()=>{},goto:async()=>{},evaluate:()=>new Promise(()=>{}),close:async()=>pageClosed++};
  const connection={contexts:()=>[{newPage:async()=>page}],close:async()=>closed++};
  const engine={connectOverCDP:async()=>{if(mode==='late connection')await new Promise(resolve=>setTimeout(resolve,150));return connection;}};
  await assert.rejects(prove({...options,engine,cdpUrl:'fixture',timeoutMs:100}),error=>error.exitCode===78);
  await new Promise(resolve=>setTimeout(resolve,200));assert.equal(closed,1);assert.equal(pageClosed,mode==='late connection'?0:1);
});

async function borrowedBrowser(t) {

  const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
  const browser = browserFixture.browser;
  t.after(() => browser.close());
  const cdpUrl = browserFixture.endpoint;
  const { chromium: cdp } = await import('playwright');
  const connection = await cdp.connectOverCDP(cdpUrl);
  t.after(() => connection.close());
  return { browser, connection, cdp, cdpUrl };
}

test('proof CLI returns 78 when the context retires during page acquisition', async t => {
  const options = await fixture(t, 'equal');
  const { browser, cdpUrl } = await borrowedBrowser(t);
  const scratch = temporaryDirectory('research-attention-retired-context-', t);
  const preload = resolve(scratch, 'retire.mjs');
  const playwrightUrl = import.meta.resolve('playwright');
  await writeFile(preload, `
    import { chromium } from ${JSON.stringify(playwrightUrl)};
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (...args) => {
      const connection = await connect(...args);
      const context = connection.contexts()[0];
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        await connection.close();
        return newPage();
      };
      return connection;
    };
  `);
  await assert.rejects(promisify(execFile)(process.execPath, [
    '--import', preload, 'scripts/prove-research-attention.mjs',
    '--origin', options.origin, '--expected-commit', options.expectedCommit, '--cdp-url', cdpUrl,
  ]), error => {
    assert.equal(error.code, 78);
    console.log(`CLI refusal exit 78 ${error.stdout.trim()}`);
    assert.equal(JSON.parse(error.stdout).status, 'insufficient_evidence');
    return true;
  });
  assert.ok(browser.isConnected(), 'borrowed browser remains connected');
});

test('proof deadline closes a late CDP page before disconnecting and preserves existing tabs', async t => {
  const options = await fixture(t, 'equal');
  const { browser, connection, cdp, cdpUrl } = await borrowedBrowser(t);
  const context = connection.contexts()[0];
  const existing = context.pages()[0] || await context.newPage();
  await existing.goto('about:blank#existing');
  const newPage = context.newPage.bind(context);
  let acquisition;
  context.newPage = () => acquisition = newPage().then(async page => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    return page;
  });
  const engine = { connectOverCDP: async () => connection };
  await assert.rejects(prove({ ...options, engine, cdpUrl, timeoutMs: 1000 }), error => error.exitCode === 78);
  assert.ok(acquisition, 'page acquisition started before deadline');
  await acquisition.catch(() => {});
  const fresh = await cdp.connectOverCDP(cdpUrl);
  try {
    const pages = fresh.contexts()[0].pages();
    assert.equal(pages.length, 1, 'only the existing tab remains');
    assert.equal(pages[0].url(), 'about:blank#existing');
    assert.ok(browser.isConnected(), 'borrowed browser remains connected');
  } finally { await fresh.close(); }
});

for (const field of ['count', 'state', 'guidance']) test(`proof CLI rejects a near-miss displayed ${field}`, async t => {
  const options = await fixture(t, 'equal');
  const { cdpUrl } = await borrowedBrowser(t);
  const scratch = temporaryDirectory('research-attention-near-miss-', t);
  const preload = resolve(scratch, 'corrupt-display.mjs');
  const expectedCount = `${recording.detail.research.evidence.length} of ${recording.detail.research.evidence.length} loaded findings`;
  const expected = { count: expectedCount, state: 'Needs review', guidance: recording.detail.research.next_step }[field];
  const displayed = field === 'count' ? `1${expected}` : `No longer ${expected}`;
  await writeFile(preload, `
    import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (...args) => {
      const connection = await connect(...args);
      const context = connection.contexts()[0];
      await context.addInitScript(({ expected, displayed }) => {
        new MutationObserver(() => {
          for (const element of document.querySelectorAll('#sourcedResearch > p')) {
            if (element.textContent === expected) element.textContent = displayed;
          }
        }).observe(document, { childList: true, subtree: true });
      }, ${JSON.stringify({ expected, displayed })});
      return connection;
    };
  `);
  await assert.rejects(promisify(execFile)(process.execPath, [
    '--import', preload, 'scripts/prove-research-attention.mjs',
    '--origin', options.origin, '--expected-commit', options.expectedCommit, '--cdp-url', cdpUrl,
  ]), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).status, 'assertion_failure');
    return true;
  });
});

for (const acquisition of ['unreachable', 'connection rejection', 'page rejection']) test(`proof CLI returns 78 for ${acquisition}`, async t => {
  const options = await fixture(t, 'equal');
  const scratch = temporaryDirectory('research-attention-acquisition-', t);
  const preload = resolve(scratch, 'reject-acquisition.mjs');
  await writeFile(preload, `
    import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
    ${acquisition === 'unreachable' ? '' : `chromium.connectOverCDP = async () => {
      ${acquisition === 'connection rejection' ? "throw Error('retired connection');" : "return { contexts: () => [{ newPage: async () => { throw Error('retired page'); } }], close: async () => {} };"}
    };`}
  `);
  const cdpUrl = await unreachableCdpEndpoint();
  await assert.rejects(promisify(execFile)(process.execPath, [
    '--import', preload, 'scripts/prove-research-attention.mjs',
    '--origin', options.origin, '--expected-commit', options.expectedCommit, '--cdp-url', cdpUrl,
  ]), error => {
    assert.equal(error.code, 78);
    console.log(`CLI refusal exit 78 ${error.stdout.trim()}`);
    assert.equal(JSON.parse(error.stdout).status, 'insufficient_evidence');
    return true;
  });
});

for (const expectedCommit of ['', 'invalid', '0'.repeat(40)]) test(`proof refuses invalid expected commit ${expectedCommit}`, async t => {
  const options = await fixture(t, 'equal');
  await assert.rejects(prove({ ...options, expectedCommit }), error => error.exitCode === 78);
});
