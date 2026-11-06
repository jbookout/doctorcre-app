import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function observe(page) {
  return page.evaluate(async () => {
    const { createClient } = await import('/js/client.js');
    const { createLiveClient } = await import('/js/live-client.js');
    const { mountEmailFollowups } = await import('/js/email-followups.js');
    const producer = await createClient('fixture');
    const initial = await producer.listEmailProposals({ include_non_deal: true, limit: 50 });
    if (initial.schema_version !== 'email-proposals.v1' || initial.send !== false || initial.proposals.length < 2) throw Error('Missing contract fixture');
    let result = structuredClone(initial), fail = false, pending;
    const reads = [];
    const client = createLiveClient({ selfActor: 'joe', fetchImpl: async (path, init) => {
      const request = JSON.parse(init.body);
      if (path === '/mcp' && request.params.name === 'preview-email-next-step') {
        const preview = await producer.previewEmailNextStep(request.params.arguments);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(preview) }] } }));
      }
      if (path !== '/mcp' || request.params.name !== 'list-email-proposals' || request.params.arguments.limit !== 50) throw Error('Unexpected read');
      reads.push(request.params);
      if (fail) throw Error('Synthetic read failure');
      if (pending) await pending;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }));
    } });
    const host = document.createElement('section');
    document.body.replaceChildren(host);
    let view = mountEmailFollowups({ container: host, client });
    const checks = [];
    const check = (condition, name) => { if (!condition) throw Error(name); checks.push(name); };
    const first = initial.proposals[0].id, second = initial.proposals[1].id;
    const details = id => [...host.querySelectorAll('[data-email-id]')].find(el => el.dataset.emailId === id)?.querySelector('details');
    try {
      await view.refresh();
      host.querySelector('[data-email-action="show"]')?.click();
      check(!details(first).open && !details(second).open, 'initial sources closed');
      details(first).open = true;
      details(first).querySelector('summary').focus();
      view.update();
      check(details(first).open && !details(second).open, 'update preserves independent disclosures');
      check(document.activeElement === details(first).querySelector('summary'), 'summary focus survives update');
      await view.click({ target: details(first).closest('article').querySelector('[data-email-action="preview"]') });
      check(details(first).open && host.textContent.includes('Confirm change'), 'review preview retains disclosure');
      await view.click({ target: details(first).closest('article').querySelector('[data-email-action="cancel"]') });
      check(details(first).open, 'cancel review retains disclosure');
      check(details(first).textContent.includes('Email text is untrusted evidence.'), 'untrusted evidence warning remains');
      let release;
      pending = new Promise(resolve => { release = resolve; });
      const refresh = view.refresh();
      check(details(first).open, 'loading render retains open source');
      release(); await refresh; pending = null;
      check(details(first).open && details(first).querySelector('q').textContent === initial.proposals[0].source.evidence_quote, 'successful refresh retains exact quote');
      details(first).open = false; details(second).open = true;
      await view.refresh(); view.update();
      check(!details(first).open && details(second).open, 'deliberate close and second row stay independent');
      fail = true; await view.refresh(); fail = false;
      check(details(second).open, 'failed refresh retains stale disclosure');
      for (const field of ['activity_id', 'evidence_quote', 'sender', 'subject', 'occurred_at']) {
        details(second).open = true;
        result = structuredClone(initial);
        result.proposals[1].preview = null;
        result.proposals[1].source[field] += field === 'evidence_quote' ? '<img src=x onerror=alert(1)>' : ' changed';
        await view.refresh();
        check(!details(second).open, `changed ${field} resets disclosure`);
        if (field === 'evidence_quote') check(!details(second).querySelector('img') && details(second).querySelector('q').textContent === result.proposals[1].source.evidence_quote, 'source quote stays escaped');
        result = structuredClone(initial); await view.refresh();
      }
      details(first).open = true;
      result = { ...structuredClone(initial), proposals: [structuredClone(initial.proposals[1])] };
      await view.refresh();
      check(!details(first), 'filtered row disappears');
      result = structuredClone(initial); await view.refresh();
      check(!details(first).open, 'returning row starts closed');
      details(first).open = true;
      window.dispatchEvent(new Event('doctorcre-session-invalidated'));
      check(!host.querySelector('details') && host.textContent.includes('Sign in'), 'session retirement clears source');
      view.dispose();
      view = mountEmailFollowups({ container: host, client }); await view.refresh();
      check(!details(first).open, 'new mount starts closed');
      details(first).open = true; view.dispose();
      check(!host.querySelector('details'), 'disposal clears source');
      return { checks, read_count: reads.length, fixture_contract: initial.schema_version };
    } finally { view.dispose(); host.remove(); }
  });
}

export async function prove({ origin, fixture = false, timeoutMs = 30000, engine = chromium }) {
  const base = new URL(origin);
  assert.equal(base.origin, origin);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000);
  const signal = AbortSignal.timeout(timeoutMs);
  let browser, requests = 0, bytes = 0;
  const release = fixture ? null : await readAppRelease(base, { timeoutMs });
  if (!fixture) return { status: 'insufficient_evidence', release, natural_authenticated_observation: 'Not executed. Requires coordinator-authorized signed-in session and merged release.', deployed_asset_fixture: null };
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Fixtures require loopback');
  try {
    browser = await launchProofBrowser(engine, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs }, { signal });
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        assert.equal(url.origin, origin); assert.equal(route.request().method(), 'GET');
        assert.ok(++requests <= 128, 'request budget');
        if (url.pathname === '/__disclosure-proof') return await route.fulfill({ contentType: 'text/html', body: '<main></main>' });
        const response = await proofFetch(url, { signal });
        assert.ok(response.ok, `asset HTTP ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer()); bytes += body.length;
        assert.ok(bytes <= 16 * 1024 * 1024, 'byte budget');
        await route.fulfill({ status: 200, contentType: response.headers.get('content-type') || '', body });
      } catch { await route.abort().catch(() => {}); }
    });
    await page.goto(origin + '/__disclosure-proof');
    const observation = await observe(page);
    return { status: 'fixture_pass', deployed_asset_fixture: observation, natural_authenticated_observation: 'not_executed', requests };
  } finally { await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args[0] === '--origin' && [4, 5].includes(args.length) && args[2] === '--timeout-ms' && (args.length === 4 || args[4] === '--fixture'), 'usage: --origin URL --timeout-ms 30000 [--fixture]');
    const receipt = await prove({ origin: args[1], timeoutMs: Number(args[3]), fixture: args[4] === '--fixture' });
    console.log(JSON.stringify(receipt));
    if (receipt.status === 'insufficient_evidence') process.exitCode = 78;
  } catch (error) {
    console.log(JSON.stringify({ status: error.exitCode === 78 || error.name === 'TimeoutError' ? 'insufficient_evidence' : 'failed', error: error.message }));
    process.exitCode = error.exitCode || (error.name === 'TimeoutError' ? 78 : 1);
  }
}
