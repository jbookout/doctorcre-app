import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
export const browserCases = [];
function test(name, run) { browserCases.push([name, run]); }
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { startFixture } from '../scripts/fixture-http.mjs';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { prove } from '../scripts/prove-quiet-lead-search.mjs';
import { assertProofDeadlineCleanup } from './proof-browser-harness.mjs';
const run = promisify(execFile), commit = '1'.repeat(40), descendant = '2'.repeat(40);
const args = ['scripts/prove-quiet-lead-search.mjs', '--fixture', '--expected-commit', commit];
test('fixture CLI passes and containing release assertion failure exits 1', async t => {
  const result = await run(process.execPath, args);
  t.diagnostic(`passing CLI ${result.stdout.trim()}`);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const root = temporaryDirectory('quiet-proof-', t), path = join(root, 'bad.json');
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
  snapshot.proposals[0].owner = 1; await writeFile(path, JSON.stringify(snapshot));
  await assert.rejects(run(process.execPath, [...args, '--recording', path]), error => { t.diagnostic(`failing CLI exit ${error.code} ${error.stdout.trim()}`); return error.code === 1; });
});
for (const kind of ['equal', 'descendant', 'older', 'unrelated', 'unknown']) test(`release ${kind}`, async () => {
  const source = kind === 'equal' ? commit : kind === 'unknown' ? undefined : descendant;
  const options = { fixture: true, expectedCommit: commit, readRelease: async () => ({ source_commit: source }), ancestry: async () => kind === 'descendant' };
  if (['equal', 'descendant'].includes(kind)) assert.equal((await prove(options)).ok, true);
  else await assert.rejects(prove(options), { exitCode: 78 });
});
test('unreachable CDP session exits 78 after verifying a containing release', async t => {
  const server = await startFixture({ routes: new Map([['/app-release', {
    contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: commit }),
  }]]) });
  t.after(() => server.close());
  await assert.rejects(run(process.execPath, [args[0], '--origin', server.origin,
    '--expected-commit', commit, '--cdp-url', 'http://127.0.0.1:1', '--timeout-ms', '5000']), error => {
    assert.equal(error.code, 78);
    assert.equal(JSON.parse(error.stdout).status, 'insufficient_evidence');
    t.diagnostic(`unreachable CLI exit ${error.code} ${error.stdout.trim()}`);
    assert.match(JSON.parse(error.stdout).error, /ECONNREFUSED/);
    return true;
  });
  assert.deepEqual(server.requests.map(request => request.path), ['/app-release']);
});
test('missing session is insufficient evidence', async () => {
  await assert.rejects(prove({ expectedCommit: commit, readRelease: async () => ({ source_commit: commit }) }), { exitCode: 78 });
});
test('no natural subjects is insufficient evidence', async t => {
  const root = temporaryDirectory('quiet-empty-', t), path = join(root, 'empty.json');
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
  snapshot.proposals = []; await writeFile(path, JSON.stringify(snapshot));
  await assert.rejects(prove({ fixture: true, expectedCommit: commit, recordingUrl: path }), { exitCode: 78 });
});
for (const mode of ['late launch', 'stalled evaluation']) test(`deadline cleanup ${mode}`, async t => {
  await assertProofDeadlineCleanup(t, { entry: args[0], args: args.slice(1), mode, timeoutMs: 2000 });
});

test('natural proof borrows a CDP session and leaves its browser running', async t => {
  const { chromium } = await import('playwright');
  const { CHROMIUM_SAFETY_ARGS } = await import('../scripts/chromium-safety-args.mjs');
  const { routeLeads } = await import('./leads-browser-fixture.mjs');

  const ownedFixture = await ownedCdpFixture(); t.after(() => ownedFixture.close());
  const owned = ownedFixture.browser;
  t.after(() => owned.close());
  const recording = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
  let borrowed;
  const engine = { connectOverCDP: async (endpoint, options) => {
    borrowed = await chromium.connectOverCDP(endpoint, options);
    const context = borrowed.contexts()[0];
    await routeLeads(context);
    await context.route('**/mcp', (route, request) => request.postDataJSON()?.params?.name === 'quiet-follow-ups' ? route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(recording) }] } } }) : route.fallback());
    return borrowed;
  } };
  const result = await prove({ expectedCommit: commit, origin: 'http://localhost', cdpUrl: ownedFixture.endpoint, engine, readRelease: async () => ({ source_commit: commit }) });
  assert.equal(result.mode, 'natural');
  assert.equal(result.ok, true);
  assert.equal(borrowed.isConnected(), false, 'proof disconnects its CDP connection');
  assert.equal(owned.isConnected(), true, 'shared browser process stays alive');
  assert.equal((await ownedFixture.context.newPage()).isClosed(), false, 'shared browser remains usable');
});

test('one total deadline includes release reads', async () => {
  await assert.rejects(prove({ expectedCommit: commit, timeoutMs: 20, readRelease: () => new Promise(() => {}) }), { exitCode: 78 });
});

test('missing expected commit remains insufficient evidence regardless of argument order', async () => {
  for (const options of [['--fixture'], ['--origin', 'http://localhost', '--timeout-ms', '1']]) {
    await assert.rejects(run(process.execPath, [args[0], ...options]), error => error.code === 78 && /Expected merge commit required/.test(error.stdout));
  }
});

for (const stage of ['connectOverCDP', 'newPage']) test(`rejected ${stage} is insufficient evidence`, async () => {
  let closed = false;
  const engine = { connectOverCDP: async () => {
    if (stage === 'connectOverCDP') throw Error('connection unavailable');
    return { contexts: () => [{ newPage: async () => { throw Error('page unavailable'); } }], close: async () => { closed = true; } };
  } };
  await assert.rejects(prove({ expectedCommit: commit, cdpUrl: 'http://localhost', engine,
    readRelease: async () => ({ source_commit: commit }) }), { exitCode: 78 });
  assert.equal(closed, stage === 'newPage');
});

test('late newPage closes before CDP disconnect and fresh connection sees no added tab', async t => {
  const { chromium } = await import('playwright');
  const { chromium: ownedEngine } = await import('../scripts/proof-browser.mjs');

  const ownedFixture = await ownedCdpFixture(); t.after(() => ownedFixture.close());
  const owned = ownedFixture.browser;
  const endpoint = ownedFixture.endpoint;
  t.after(() => owned.close());
  const existing = ownedFixture.page;
  let created;
  const engine = { connectOverCDP: async () => {
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0], newPage = context.newPage.bind(context);
    context.newPage = async () => {
      created = await newPage();
      await new Promise(resolve => setTimeout(resolve, 1500));
      return created;
    };
    return browser;
  } };
  await assert.rejects(prove({ expectedCommit: commit, cdpUrl: endpoint, engine, timeoutMs: 1000,
    readRelease: async () => ({ source_commit: commit }) }), { exitCode: 78 });
  await new Promise(resolve => setTimeout(resolve, 1700));
  const fresh = await chromium.connectOverCDP(endpoint);
  try {
    assert.ok(created, 'page creation actually executed');
    assert.equal(fresh.contexts()[0].pages().length, 1);
    assert.equal(existing.isClosed(), false);
  } finally { await fresh.close(); }
});

test('leading-digit near miss in displayed matching count fails the CLI', async t => {
  const root = temporaryDirectory('quiet-count-near-miss-', t), preload = join(root, 'preload.mjs');
  await writeFile(preload, `
    import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
    const launch = chromium.launch.bind(chromium);
    chromium.launch = async options => {
      const browser = await launch(options), newPage = browser.newPage.bind(browser);
      browser.newPage = async (...args) => {
        const page = await newPage(...args);
        await page.addInitScript(() => {
          new MutationObserver(() => {
            for (const status of document.querySelectorAll('#quietFollowUps p[role="status"]')) {
              if (status.textContent.startsWith('Showing 1–')) status.textContent = status.textContent.replace('Showing 1–', 'Showing 11–');
            }
          }).observe(document, { subtree: true, childList: true, characterData: true });
        });
        return page;
      };
      return browser;
    };
  `);
  await assert.rejects(run(process.execPath, ['--import', preload, ...args]), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).status, 'assertion_failure');
    return true;
  });
});

test('newPage rejection exits 78 through the CLI', async t => {
  const root = temporaryDirectory('quiet-page-rejection-', t), preload = join(root, 'preload.mjs');
  await writeFile(preload, `
    import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
    const launch = chromium.launch.bind(chromium);
    chromium.launch = async options => {
      const browser = await launch(options);
      browser.newPage = async () => { throw Error('page unavailable'); };
      return browser;
    };
  `);
  await assert.rejects(run(process.execPath, ['--import', preload, ...args]), error => {
    assert.equal(error.code, 78);
    assert.equal(JSON.parse(error.stdout).status, 'insufficient_evidence');
    assert.match(JSON.parse(error.stdout).error, /page unavailable/);
    return true;
  });
});

for (const expectedCommit of ['', 'abc', '0'.repeat(40)]) test(`invalid commit ${expectedCommit || 'empty'} refuses`, async () => {
  await assert.rejects(prove({ fixture: true, expectedCommit }), { exitCode: 78 });
});
test('changing containing release is insufficient evidence', async () => {
  let reads = 0;
  await assert.rejects(prove({ fixture: true, expectedCommit: commit, ancestry: async () => true,
    readRelease: async () => ({ source_commit: ++reads === 1 ? commit : descendant }) }), { exitCode: 78 });
});
