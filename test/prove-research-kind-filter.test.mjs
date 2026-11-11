import { unreachableCdpEndpoint } from "./unreachable-cdp-fixture.ts";
import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
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
import { prove } from '../scripts/prove-research-kind-filter.mjs';
const recording = JSON.parse(await readFile(new URL('./fixtures/research-kind-filter/recordings.json', import.meta.url)));
validateLeadWorkspace(recording); validateLeadDetail(recording.detail, recording.detail.id);
const assets = await appAssetSnapshot();
async function fixture(t, mode) {
  const history = temporaryDirectory('research-kind-history-', t);
  const git = (...args) => execFileSync('git', args, { cwd: history, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git('init');
  const commit = async text => { await writeFile(resolve(history, 'revision'), text); git('add', 'revision'); git('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m',text); return git('rev-parse','HEAD'); };
  const older = await commit('older'), expectedCommit = await commit('expected'), descendant = await commit('descendant');
  git('checkout','--orphan','unrelated'); const unrelated = await commit('unrelated');
  const released = { older, descendant, unrelated, unknown: 'f'.repeat(40) }[mode] || expectedCommit;
  const snapshot = new Map([...assets].map(([path, value]) => [path, {
    ...value, body: mode === 'failure' && path === '/js/ui-lead-research.generated.js'
      ? value.body.toString().replaceAll('data-flag-id', 'data-wrong-id') : value.body,
  }]));
  const server = await startWorkerFixture({ assets: snapshot, env: {
    APP_ENV: 'production', GIT_SHA: released,
    CARR: { fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === '/mcp') {
        const body = await request.json();
        if (body.params?.name === "list-verbs") return Response.json({result:{content:[{type:"text",text:JSON.stringify(registry)}]}});
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text:
          JSON.stringify(body.params?.name === 'lead-board' ? recording : { error: 'fixture_read_unavailable' }),
        }] } });
      }
      return Response.json({ actor: { slug: 'example-partner' }, csrf_token: 'synthetic-test-token' });
    } },
  } });
  t.after(() => server.close());
  return { origin: server.origin, expectedCommit, ancestryCwd: history };
}
for (const mode of ['equal','descendant','older','unrelated','unknown','failure','session']) test(`proof ${mode}`, async t => {
  const options=await fixture(t,mode);
  if (['older','unrelated','unknown','session'].includes(mode)) {
    await assert.rejects(prove(options), error=>error.exitCode===78);return;
  }
  if (mode === 'equal' || mode === 'failure') {

    const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
    const browser = browserFixture.browser;
    t.after(() => browser.close());
    const args = ['scripts/prove-research-kind-filter.mjs', '--origin', options.origin, '--expected-commit', options.expectedCommit, '--cdp-url', browserFixture.endpoint];
    if (mode === 'failure') await assert.rejects(promisify(execFile)(process.execPath, args), error => error.code === 1);
    else assert.equal(JSON.parse((await promisify(execFile)(process.execPath, args)).stdout).status, 'passed');
    assert.ok(browser.isConnected(), 'proof disconnect preserves acquired test browser');
    assert.equal((await browser.newContext()).pages().length, 0);
    return;
  }
  const browser=await chromium.launch(); t.after(()=>browser.close());
  await browser.newContext();
  const engine={connectOverCDP:async()=>browser};
  assert.equal((await prove({...options,engine,cdpUrl:'fixture'})).status,'passed');
});
for(const mode of ['late connection','stalled evaluation']) test(`proof deadline cleans ${mode}`,async t=>{
  const options=await fixture(t,'equal');let closed=0,pageClosed=0;
  const page={on(){},setDefaultTimeout(){},route:async()=>{},goto:async()=>{},evaluate:()=>new Promise(()=>{}),close:async()=>pageClosed++};
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
  const scratch = temporaryDirectory('research-kind-retired-context-', t);
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
    '--import', preload, 'scripts/prove-research-kind-filter.mjs',
    '--origin', options.origin, '--expected-commit', options.expectedCommit, '--cdp-url', cdpUrl,
  ]), error => {
    assert.equal(error.code, 78);
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
  const scratch = temporaryDirectory('research-kind-near-miss-', t);
  const preload = resolve(scratch, 'corrupt-display.mjs');
  const kind = recording.detail.research.evidence.find(item => item.kind.trim()).kind;
  const expectedCount = `${recording.detail.research.evidence.filter(item => item.kind === kind).length} of ${recording.detail.research.evidence.length} loaded findings`;
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
    '--import', preload, 'scripts/prove-research-kind-filter.mjs',
    '--origin', options.origin, '--expected-commit', options.expectedCommit, '--cdp-url', cdpUrl,
  ]), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).status, 'assertion_failure');
    return true;
  });
});

for (const acquisition of ['unreachable', 'connection rejection', 'page rejection']) test(`proof CLI returns 78 for ${acquisition}`, async t => {
  const options = await fixture(t, 'equal');
  const scratch = temporaryDirectory('research-kind-acquisition-', t);
  const preload = resolve(scratch, 'reject-acquisition.mjs');
  await writeFile(preload, `
    import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
    ${acquisition === 'unreachable' ? '' : `chromium.connectOverCDP = async () => {
      ${acquisition === 'connection rejection' ? "throw Error('retired connection');" : "return { contexts: () => [{ newPage: async () => { throw Error('retired page'); } }], close: async () => {} };"}
    };`}
  `);
  const cdpUrl = await unreachableCdpEndpoint();
  await assert.rejects(promisify(execFile)(process.execPath, [
    '--import', preload, 'scripts/prove-research-kind-filter.mjs',
    '--origin', options.origin, '--expected-commit', options.expectedCommit, '--cdp-url', cdpUrl,
  ]), error => {
    assert.equal(error.code, 78);
    assert.equal(JSON.parse(error.stdout).status, 'insufficient_evidence');
    return true;
  });
});

const registry = JSON.parse(await readFile(new URL("./fixtures/walk-verb-registry.json", import.meta.url))).response;

for (const mode of ['extra read', 'future read', 'write', 'unknown', 'unreadable', 'malformed', 'incomplete', 'empty', 'cleanup write', 'cleanup unknown']) test(`registry CLI ${mode}`, async t => {
  const f = await fixture(t, 'equal');
  const scratch = temporaryDirectory('registry-cli-', t);
  const preload = resolve(scratch, 'preload.mjs');
  const marker = resolve(scratch, 'forwarded');
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

  const { chromium: owner } = await import('../scripts/proof-browser.mjs');
  const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
  const browser = browserFixture.browser;
  t.after(() => browser.close());
  const cliArgs = ['--import', preload, 'scripts/prove-research-kind-filter.mjs', '--origin', f.origin, '--expected-commit', f.expectedCommit, '--cdp-url', browserFixture.endpoint];
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
