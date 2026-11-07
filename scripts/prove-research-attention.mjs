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
    await page.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== base.origin) return route.abort();
      if (req.method() === 'POST') {
        const name = req.postDataJSON()?.params?.name;
        if (!['lead-board', 'quiet-follow-ups', 'list-practice-origination', 'territory-state-board', 'read-home-agenda', 'deal-room-board'].includes(name)) return route.abort();
        calls++;
      } else if (req.method() !== 'GET') return route.abort();
      return route.continue();
    });
    await page.goto(new URL('/leads', base).href, { timeout: remaining() }).catch(() => { throw unavailable('Natural lead page unavailable'); });
    const detail = await page.evaluate(async () => {
      const { createLeadBoardClient } = await import('/js/leads-client.js');
      const client = createLeadBoardClient();
      if (!await client.getActor()) return null;
      const board = await client.getWorkspace();
      for (const lead of board.leads.slice(0, 20)) {
        const { detail } = await client.getLeadDetail(lead);
        if (detail?.research?.evidence.some(item => item.kind.trim() && item.source.trim())) return detail;
      }
      return null;
    }).catch(() => { throw unavailable('Signed-in business read unavailable'); });
    if (!detail) throw unavailable('No eligible natural subject in first 20 loaded leads');
    const button = page.locator(`[data-open="${detail.id}"]`).first();
    await button.waitFor({ timeout: remaining() }).catch(() => { throw unavailable('Natural subject is not visible'); });
    await button.click();
    const panel = page.locator('#sourcedResearch');
    await panel.waitFor();
    const evidence = detail.research.evidence;
    const factText = value => Array.isArray(value) ? `[${value.map(factText).join(', ')}]` : value && typeof value === 'object' ? `{${Object.entries(value).map(([key, item]) => `${key}: ${factText(item)}`).join('; ')}}` : value == null ? 'null' : String(value);
    const kind = evidence.find(item => item.kind.trim()).kind;
    const beforeCalls = calls;
    const assertions = [];
    let assertionFailure, intersection = [];
    try {
      for (const attention of ['', 'correction', 'expired', 'nothing']) {
        await panel.getByLabel('Finding attention', { exact: true }).selectOption(attention);
        const expected = evidence.filter(item => attention === '' || attention === 'correction' && item.proposes_correction === true || attention === 'expired' && item.expired === true || attention === 'nothing' && item.found === false);
        assert.deepEqual(await panel.locator('li').evaluateAll(nodes => nodes.map(n => n.dataset.flagId)), expected.map(item => item.flag_id));
        assert.equal(await panel.getByRole('status').innerText(), `${expected.length} of ${evidence.length} loaded findings`, 'matching count');
        assert.equal(await panel.locator(':scope > p').nth(0).innerText(), { needs_review: 'Needs review', needs_research: 'Needs research', verified: 'Verified' }[detail.research.state], 'server state preserved');
        assert.equal(await panel.locator(':scope > p').nth(1).innerText(), detail.research.next_step, 'server guidance preserved');
        for (let index = 0; index < expected.length; index++) {
          const item = expected[index], row = panel.locator('li').nth(index);
          assert.equal(await row.locator('.research-finding').innerText(), `${item.found ? 'Finding recorded.' : 'Nothing found.'} ${factText(item.value)}`);
          assert.equal(await row.locator('a').count(), /^https:\/\/\S+$/.test(item.source.trim()) ? 1 : 0);
          if (await row.locator('a').count()) assert.equal(await row.locator('a').getAttribute('href'), item.source.trim());
        }
        assertions.push({ attention, ids: expected.map(item => item.flag_id), count: expected.length });
      }
      await panel.getByLabel('Finding kind', { exact: true }).selectOption(kind);
      intersection = evidence.filter(item => item.kind === kind && item.found === false);
      assert.deepEqual(await panel.locator('li').evaluateAll(nodes => nodes.map(n => n.dataset.flagId)), intersection.map(item => item.flag_id));
      assert.equal(await panel.getByRole('status').innerText(), `${intersection.length} of ${evidence.length} loaded findings`);
      await panel.getByLabel('Finding attention', { exact: true }).selectOption('');
      await panel.getByLabel('Finding kind', { exact: true }).selectOption('');
      assert.deepEqual(await panel.locator('li').evaluateAll(nodes => nodes.map(n => n.dataset.flagId)), evidence.map(item => item.flag_id));
      assert.equal(calls, beforeCalls, 'selection performs no RPC');
    } catch (error) { assertionFailure = error; }
    const after = await release(); if (after.source_commit !== before.source_commit) throw unavailable('Release changed during proof');
    if (assertionFailure) throw assertionFailure;
    return { status: 'passed', before, after, subject: detail.id, kind, count: detail.research.evidence.length, assertions, intersection: intersection.map(item => item.flag_id), reads: calls };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable('Total proof deadline exceeded')); }, timeoutMs); })]);
  } catch (error) { if (controller.signal.aborted) throw unavailable('Total proof deadline exceeded'); throw error; }
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
