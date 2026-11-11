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
import { prove } from '../scripts/prove-quiet-lead-owner-pages.mjs';
import { assertProofDeadlineCleanup } from './proof-browser-harness.mjs';
const run = promisify(execFile), commit = '1'.repeat(40), descendant = '2'.repeat(40);
const args = ['scripts/prove-quiet-lead-owner-pages.mjs', '--fixture', '--expected-commit', commit];
test('fixture CLI passes and containing release assertion failure exits 1', async t => {
  const result = await run(process.execPath, args);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const root = temporaryDirectory('quiet-proof-', t), path = join(root, 'bad.json');
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
  snapshot.proposals[0].owner = 1; await writeFile(path, JSON.stringify(snapshot));
  await assert.rejects(run(process.execPath, [...args, '--recording', path]), error => error.code === 1);
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

for (const registryMode of ['read-only', 'stale write flag', 'unknown', 'unreadable', 'malformed', 'deadline']) test(`natural proof live registry ${registryMode} and borrowed browser cleanup`, async t => {
  const { chromium } = await import('playwright');
  const { CHROMIUM_SAFETY_ARGS } = await import('../scripts/chromium-safety-args.mjs');
  const { routeLeads } = await import('./leads-browser-fixture.mjs');

  const ownedFixture = await ownedCdpFixture(); t.after(() => ownedFixture.close());
  const owned = ownedFixture.browser;
  t.after(() => owned.close());
  const recording = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
  const registry = JSON.parse(await readFile(new URL('./fixtures/walk-verb-registry.json', import.meta.url))).response;
  assert.equal(registry.verbs.find(verb => verb.name === 'quiet-follow-ups').write, false);
  if (registryMode === 'stale write flag') registry.verbs.find(verb => verb.name === 'quiet-follow-ups').write = true;
  if (registryMode === 'unknown') registry.verbs = registry.verbs.filter(verb => verb.name !== 'quiet-follow-ups');
  registry.count = registry.verbs.length;
  if (registryMode === 'malformed') delete registry.verbs[0].write;
  let borrowed, registryReads = 0;
  const engine = { connectOverCDP: async (endpoint, options) => {
    borrowed = await chromium.connectOverCDP(endpoint, options);
    const context = borrowed.contexts()[0];
    await routeLeads(context);
    await context.route('**/mcp', async (route, request) => {
      const name = request.postDataJSON()?.params?.name;
      if (name === 'list-verbs') {
        registryReads++;
        if (registryMode === 'unreadable') return route.fulfill({ status: 503, body: 'Unavailable' });
        if (registryMode === 'deadline') return;
        return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(registry) }] } } });
      }
      if (name === 'quiet-follow-ups') return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(recording) }] } } });
      return route.fallback();
    });
    return borrowed;
  } };
  const execution = prove({ expectedCommit: commit, origin: 'http://localhost', cdpUrl: ownedFixture.endpoint, engine,
    timeoutMs: registryMode === 'deadline' ? 5000 : 30000, readRelease: async () => ({ source_commit: commit }) });
  if (registryMode === 'read-only') {
    const result = await execution;
    assert.equal(result.mode, 'natural');
    assert.equal(result.ok, true);
    assert.equal(result.writes, 0);
  } else if (['unreadable', 'malformed', 'deadline'].includes(registryMode)) await assert.rejects(execution, { exitCode: 78 });
  else await assert.rejects(execution, registryMode === 'unknown' ? /Unknown MCP verbs: quiet-follow-ups/ : /no writes/);
  assert.equal(registryReads, 1, 'one live registry read, no snapshot fallback or retries');
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

for (const kind of ['read-only', 'write', 'unknown']) test(`registry ${kind} MCP calls through the CLI`, async t => {
  const registry = JSON.parse(await readFile(new URL('./fixtures/walk-verb-registry.json', import.meta.url))).response.verbs;
  const names = kind === 'read-only' ? registry.filter(verb => verb.write === false).map(verb => verb.name)
    : [kind === 'write' ? registry.find(verb => verb.write === true).name : 'unregistered-proof-verb'];
  const root = temporaryDirectory('quiet-registry-', t), preload = join(root, 'preload.mjs');
  await writeFile(preload, `
    import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
    const launch = chromium.launch.bind(chromium);
    chromium.launch = async options => {
      const browser = await launch(options), newPage = browser.newPage.bind(browser);
      browser.newPage = async (...args) => {
        const page = await newPage(...args);
        await page.addInitScript(names => {
          document.addEventListener('DOMContentLoaded', () => {
            for (const name of names) void fetch('/mcp', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: {} } }),
            });
          });
        }, ${JSON.stringify(names)});
        return page;
      };
      return browser;
    };
  `);
  const execution = run(process.execPath, ['--import', preload, ...args]);
  if (kind === 'read-only') assert.equal(JSON.parse((await execution).stdout).ok, true);
  else await assert.rejects(execution, error => {
    assert.equal(error.code, 1);
    const result = JSON.parse(error.stdout);
    assert.equal(result.status, 'assertion_failure');
    assert.match(result.error, kind === 'unknown' ? /Unknown MCP verbs: unregistered-proof-verb/ : /no writes/);
    return true;
  });
});
