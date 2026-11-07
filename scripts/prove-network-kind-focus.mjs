import { guardProofReads } from './proof-verb-registry.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { readAppRelease, proofFetch } from './app-release-reader.mjs';
const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });

export async function prove({ origin, expectedCommit, cdpUrl, timeoutMs = 30000, engine = chromium, ancestryCwd } = {}) {
  let base;
  try { base = new URL(origin || 'http://localhost'); } catch { throw unavailable('Origin required'); }
  if (!(base.href === `${base.origin}/` && !base.username && !base.password && (base.protocol === 'https:' || base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)))) throw unavailable('Origin required');
  if (!(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000)) throw unavailable('Bounded deadline required');
  const controller = new AbortController(), deadline = performance.now() + timeoutMs;
  const remaining = () => { const ms = Math.ceil(deadline - performance.now()); if (ms <= 0) throw unavailable('Total proof deadline exceeded'); return ms; };
  let guard;
  let page, connection, pendingConnection, pendingPage, timer;
  const release = () => readAppRelease(base, async url => {
    const response = await proofFetch(url, { signal: controller.signal });
    return { type: response.headers.get('content-type') || '', body: Buffer.from(await response.arrayBuffer()) };
  });
  const work = async () => {
    const before = await release();
    if (!/^[a-f0-9]{40}$/.test(expectedCommit || '') || /^0+$/.test(expectedCommit)) throw unavailable('Expected merge commit required');
    if (before.source_commit !== expectedCommit) {
      try {
        await new Promise((resolve, reject) => {
          const child = execFile('git', ['merge-base', '--is-ancestor', expectedCommit, before.source_commit], { cwd: ancestryCwd, timeout: remaining(), signal: controller.signal, killSignal: 'SIGKILL' }, error => error ? reject(error) : resolve());
          child.on('error', reject);
        });
      } catch { throw unavailable('Release containment is unproved'); }
    }
    if (!cdpUrl) throw unavailable('Existing signed-in browser required');
    pendingConnection = Promise.resolve().then(() => engine.connectOverCDP(cdpUrl, { timeout: remaining() })).catch(() => { throw unavailable('Existing signed-in browser unavailable'); });
    connection = await pendingConnection; controller.signal.throwIfAborted();
    const context = connection.contexts()[0];
    if (!context) throw unavailable('Existing signed-in context required');
    pendingPage = Promise.resolve().then(() => context.newPage()).catch(() => { throw unavailable('Existing signed-in page unavailable'); }); page = await pendingPage; controller.signal.throwIfAborted();
    page.setDefaultTimeout(remaining());
    let calls = 0;
    guard = await guardProofReads(page, base.origin);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === base.origin && (url.pathname === '/mcp' || url.pathname === '/api/v1/business/relationships')) calls++;
    });
    await page.goto(new URL('/relationships', base).href, { timeout: remaining(), waitUntil: 'domcontentloaded' }).catch(() => { throw unavailable('Natural relationship page unavailable'); });
    await guard.load(remaining());
    const snapshot = await page.evaluate(async () => {
      const { createLiveClient } = await import('/js/live-client.js');
      const { validNetwork } = await import('/js/relationship-network-model.js');
      const value = await createLiveClient().getRelationshipNetwork();
      return validNetwork(value) ? value : null;
    }).catch(() => { throw unavailable('Signed-in relationship read unavailable'); });
    if (!snapshot || !snapshot.nodes.length || Date.parse(snapshot.valid_until) <= Date.now()) throw unavailable('No fresh natural relationship subjects');
    await page.locator('#networkNodes [data-node]').first().waitFor({ timeout: remaining() }).catch(() => { throw unavailable('Natural relationships unavailable'); });
    const kind = snapshot.nodes[0].kind;
    const nodes = snapshot.nodes.filter(n => n.kind === kind);
    const matches = new Set(nodes.map(n => n.id));
    const expected = {nodes, edges:snapshot.edges.filter(e => matches.has(e.from) && matches.has(e.to) && (!e.via || matches.has(e.via)))};
    const ids = new Set(expected.nodes.map(n => n.id));
    const beforeCalls = calls;
    await page.getByLabel('Relationship kind', {exact:true}).selectOption(kind);
    assert.deepEqual(await page.locator('#networkNodes [data-node]').evaluateAll(nodes => nodes.map(n => n.dataset.node)), expected.nodes.map(n => n.id), 'exact kind subset');
    assert.equal(await page.locator('#networkCount').innerText(), String(expected.nodes.length), 'exact count');
    const edges = await page.locator('[data-edge-from]').evaluateAll(nodes => nodes.map(n => ({from:n.dataset.edgeFrom,to:n.dataset.edgeTo,via:n.dataset.edgeVia})));
    for (const edge of edges) {
      assert.ok(ids.has(edge.from) && ids.has(edge.to) && (!edge.via || ids.has(edge.via)), 'complete path endpoints');
      assert.ok(expected.edges.some(e => e.from === edge.from && e.to === edge.to && (e.via || '') === edge.via), 'recorded edge');
    }
    await page.locator('#networkReset').click();
    assert.deepEqual(await page.locator('#networkNodes [data-node]').evaluateAll(nodes => nodes.map(n => n.dataset.node)), snapshot.nodes.map(n => n.id), 'reset restores exact directory');
    assert.equal(calls, beforeCalls, 'local filters perform no business reads');
    guard.assertSafe();
    const after = await release(); assert.equal(after.source_commit, before.source_commit, 'stable release'); guard.assertSafe();
    return { status: 'passed', writes: guard.writes, before, after, kind, count: expected.nodes.length };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable('Total proof deadline exceeded')); }, timeoutMs); })]);
  } catch (error) { guard?.assertSafe(); if (controller.signal.aborted) throw unavailable('Total proof deadline exceeded'); throw error; }
  finally {
    clearTimeout(timer); controller.abort(); guard?.dispose();
    const acquiredPage = page || await pendingPage?.catch(() => undefined);
    await acquiredPage?.close().catch(() => {});
    const acquiredConnection = connection || await pendingConnection?.catch(() => undefined);
    await acquiredConnection?.close().catch(() => {});
    guard?.assertSafe();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
  try {
    const receipt = await prove({ origin: args.includes('--origin') ? value('--origin') : undefined, expectedCommit: args.includes('--expected-commit') ? value('--expected-commit') : undefined, cdpUrl: args.includes('--cdp-url') ? value('--cdp-url') : undefined, timeoutMs: Number(args.includes('--timeout-ms') ? value('--timeout-ms') : 30000) });
    console.log(JSON.stringify(receipt));
  } catch (error) { console.log(JSON.stringify({ status: error.exitCode === 78 ? 'insufficient_evidence' : 'assertion_failure', error: error.message })); process.exitCode = error.exitCode || 1; }
}
