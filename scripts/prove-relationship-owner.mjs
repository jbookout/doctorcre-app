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
  let page, connection, pendingConnection, pendingPage, timer;
  let phase = 'release';
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
    phase = 'browser acquisition';
    pendingConnection = Promise.resolve().then(() => engine.connectOverCDP(cdpUrl, { timeout: remaining() })).catch(() => { throw unavailable('Existing signed-in browser unavailable'); });
    connection = await pendingConnection; controller.signal.throwIfAborted();
    const context = connection.contexts()[0];
    if (!context) throw unavailable('Existing signed-in context required');
    phase = 'page acquisition';
    pendingPage = Promise.resolve().then(() => context.newPage()).catch(() => { throw unavailable('Existing signed-in page unavailable'); }); page = await pendingPage; controller.signal.throwIfAborted();
    page.setDefaultTimeout(remaining());
    let calls = 0, blockedWrites = 0;
    let verbWrites = new Map();
    await page.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== base.origin) return route.abort();
      if (url.pathname === '/api/v1/business/relationships') calls++;
      if (req.method() === 'POST') {
        const name = req.postDataJSON()?.params?.name;
        if (name !== 'list-verbs' && verbWrites.get(name) !== false) {
          if (verbWrites.get(name) === true) blockedWrites++;
          return route.abort();
        }
        calls++;
      } else if (req.method() !== 'GET') return route.abort();
      return route.continue();
    });
    phase = 'navigation';
    await page.goto(new URL('/relationships?mode=live', base).href, { timeout: remaining() }).catch(() => { throw unavailable('Natural relationship page unavailable'); });
    phase = 'registry';
    const registry = await page.evaluate(async timeoutMs => {
      const { createMcpRequests } = await import('/js/mcp-requests.mjs');
      return createMcpRequests()('list-verbs', { names_only: true }, { timeoutMs });
    }, remaining()).catch(() => { throw unavailable('Verb registry unavailable'); });
    const verbs = registry?.payload?.verbs;
    if (registry.kind !== 'payload' || registry.isError || registry.payload?.ok !== true || !Array.isArray(verbs) || !verbs.length || registry.payload.count !== verbs.length || !verbs.every(v => typeof v.name === 'string' && typeof v.write === 'boolean') || new Set(verbs.map(v => v.name)).size !== verbs.length) throw unavailable('Verb registry unavailable');
    verbWrites = new Map(verbs.map(v => [v.name, v.write]));
    phase = 'snapshot';
    const snapshot = await page.evaluate(async () => {
      const { createLiveClient } = await import('/js/live-client.js');
      const { validNetwork } = await import('/js/relationship-network-model.js');
      const value = await createLiveClient().getRelationshipNetwork();
      return validNetwork(value) ? value : null;
    }).catch(() => { throw unavailable('Signed-in relationship read unavailable'); });
    if (!snapshot || !snapshot.nodes.length || Date.parse(snapshot.valid_until) <= Date.now()) throw unavailable('No fresh natural relationship subjects');
    phase = 'directory';
    await page.locator('#networkNodes [data-node]').first().waitFor({ timeout: remaining() }).catch(() => { throw unavailable('Natural relationships unavailable'); });
    const ownerValues = [...new Set(snapshot.nodes.map(n => JSON.stringify([n.owner?.trim() ? n.owner : null])))];
    if (ownerValues.length < 2) throw unavailable('No eligible natural owner outcomes');
    const owner = ownerValues[0];
    const nodes = snapshot.nodes.filter(n => JSON.stringify([n.owner?.trim() ? n.owner : null]) === owner);
    const matches = new Set(nodes.map(n => n.id));
    const expected = {nodes, edges:snapshot.edges.filter(e => matches.has(e.from) && matches.has(e.to) && (!e.via || matches.has(e.via)))};
    const ids = new Set(expected.nodes.map(n => n.id));
    const beforeCalls = calls;
    await page.getByLabel('Recorded owner', {exact:true}).selectOption(owner);
    assert.deepEqual(await page.locator('#networkNodes [data-node]').evaluateAll(nodes => nodes.map(n => n.dataset.node)), expected.nodes.map(n => n.id), 'exact owner subset');
    assert.equal(await page.locator('#networkCount').innerText(), String(expected.nodes.length), 'exact count');
    assert.equal(await page.getByLabel('Recorded owner', {exact:true}).inputValue(), owner, 'exact selected owner');
    const expectedReferrals = snapshot.referrals.filter(row => ids.has(row.node_id)).sort((a,b) => b.deals-a.deals || a.node_id.localeCompare(b.node_id));
    assert.deepEqual(await page.locator('#networkReferrals [data-node]').evaluateAll(nodes => nodes.map(n => n.dataset.node)), expectedReferrals.map(row => row.node_id), 'exact referral rows');
    const expectedIntroductions = snapshot.suggestions.filter(row => ids.has(row.from) && ids.has(row.to) && (!row.via || ids.has(row.via))).slice(0,6);
    assert.deepEqual(await page.locator('#networkIntroductions [data-node]').evaluateAll(nodes => nodes.map(n => n.dataset.node)), expectedIntroductions.map(row => row.to), 'exact introduction rows');
    const edges = await page.locator('[data-edge-from]').evaluateAll(nodes => nodes.map(n => ({from:n.dataset.edgeFrom,to:n.dataset.edgeTo,via:n.dataset.edgeVia})));
    for (const edge of edges) {
      assert.ok(ids.has(edge.from) && ids.has(edge.to) && (!edge.via || ids.has(edge.via)), 'complete path endpoints');
      assert.ok(expected.edges.some(e => e.from === edge.from && e.to === edge.to && (e.via || '') === edge.via), 'recorded edge');
    }
    await page.locator('#networkReset').click();
    assert.deepEqual(await page.locator('#networkNodes [data-node]').evaluateAll(nodes => nodes.map(n => n.dataset.node)), snapshot.nodes.map(n => n.id), 'reset restores exact directory');
    assert.equal(calls, beforeCalls, 'local filters perform no business reads');
    assert.equal(blockedWrites, 0, 'zero attempted business writes');
    const after = await release(); assert.equal(after.source_commit, before.source_commit, 'stable release');
    return { status: 'passed', before, after, owner, businessWrites: 0, count: expected.nodes.length };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable(`Total proof deadline exceeded during ${phase}`)); }, timeoutMs); })]);
  } catch (error) { if (controller.signal.aborted) throw unavailable(`Total proof deadline exceeded during ${phase}`); throw error; }
  finally {
    clearTimeout(timer); controller.abort();
    const acquiredPage = page || await pendingPage?.catch(() => undefined);
    await acquiredPage?.close().catch(() => {});
    const acquiredConnection = connection || await pendingConnection?.catch(() => undefined);
    await acquiredConnection?.close().catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
  try {
    const receipt = await prove({ origin: args.includes('--origin') ? value('--origin') : undefined, expectedCommit: args.includes('--expected-commit') ? value('--expected-commit') : undefined, cdpUrl: args.includes('--cdp-url') ? value('--cdp-url') : undefined, timeoutMs: Number(args.includes('--timeout-ms') ? value('--timeout-ms') : 30000) });
    console.log(JSON.stringify(receipt));
  } catch (error) { console.log(JSON.stringify({ status: error.exitCode === 78 ? 'insufficient_evidence' : 'assertion_failure', error: error.message })); process.exitCode = error.exitCode || 1; }
}
