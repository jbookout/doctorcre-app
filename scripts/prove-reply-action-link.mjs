import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { requireContainingRelease } from './prove-fact-review-pending-status-view.mjs';

const insufficient = message => Object.assign(Error(message), { exitCode: 78 });
export function signedInReplyEngine(endpoint, engine = chromium) {
  const url = new URL(endpoint);
  assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && !url.username && !url.password, 'loopback CDP required');
  return { async launch(options) {
    let connection;
    try { connection = await engine.connectOverCDP(endpoint, { timeout: options.timeout }); }
    catch { throw insufficient('Signed-in browser unavailable'); }
    const acquisitions = [];
    let closing = false;
    return {
      async newPage() {
        const context = connection.contexts()[0];
        if (!context) throw insufficient('Signed-in context unavailable');
        const pending = context.newPage().then(async page => { if (closing) await page.close(); return page; }, () => { throw insufficient('Signed-in page unavailable'); });
        acquisitions.push(pending);
        return pending;
      },
      async close() {
        closing = true;
        try { for (const pending of acquisitions) await pending.then(page => page.close(), () => {}); }
        finally { await connection.close(); }
      },
    };
  } };
}

export async function prove({ origin, commit, ref, proposalId, foreignRef, timeoutMs = 30000, engine }) {
  let stage = 'release';
  const lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(insufficient(`Total proof deadline exceeded at ${stage}`)), timeoutMs);
  let browser, acquisition;
  try {
    const get = async url => {
      const response = await proofFetch(url, { signal: lifetime.signal, cache: 'no-store' });
      return { type: response.headers.get('content-type') || '', body: Buffer.from(await response.arrayBuffer()) };
    };
    const release = await readAppRelease(origin, get);
    assert.match(commit || '', /^[a-f0-9]{40}$/);
    assert.ok(!/^0+$/.test(commit));
    await requireContainingRelease(commit, release.source_commit, { signal: lifetime.signal });
    if (!engine) throw insufficient('Use --cdp-url with an existing authorized partner session');
    assert.match(ref || '', /^al1_[A-Za-z0-9_-]{1,120}$/);
    assert.match(foreignRef || '', /^al1_[A-Za-z0-9_-]{1,120}$/);
    assert.notEqual(ref, foreignRef);
    assert.match(proposalId || '', /^[0-9a-f-]{36}$/i);
    browser = await launchProofBrowser({ launch(options) { acquisition = engine.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] }); return acquisition; } }, { timeout: timeoutMs, args: [...CHROMIUM_SAFETY_ARGS] }, { signal: lifetime.signal });
    const page = await browser.newPage();
    let requests = 0, violation;
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (++requests > 512 || url.origin !== origin || !['GET', 'POST'].includes(request.method())) { violation = 'Network budget or origin violation'; return route.abort(); }
      if (request.method() === 'POST') {
        let rpc;
        try { rpc = request.postDataJSON(); } catch {}
        if (rpc?.method === 'tools/call' && ['deal-room-board', 'morning-brief', 'calendar-meeting-prep'].includes(rpc.params?.name)) return route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'proof_unrelated_read_refused' }) }] } } });
        if (url.pathname !== '/mcp' || rpc?.method !== 'tools/call' || rpc.params?.name !== 'resolve-action-link' || ![ref, foreignRef].includes(rpc.params.arguments?.ref)) { violation = 'Only the two reference reads are authorized'; return route.abort(); }
      }
      return route.continue();
    });
    stage = 'open authorized reference';
    await page.goto(`${origin}/a/${ref}?mode=live`);
    await page.waitForFunction(() => !document.querySelector('#actionLink')?.textContent.includes('Opening draft'));
    if (!await page.locator('[data-proposal-id]').count()) throw insufficient('Authorized reply review unavailable or session not signed in');
    assert.equal(await page.locator('[data-proposal-id]').getAttribute('data-proposal-id'), proposalId, 'exact displayed proposal identity');
    stage = 'independent resolve';
    const independent = await page.evaluate(async ref => {
      const { createMcpRequests } = await import('/js/mcp-requests.mjs');
      const { parseDraft } = await import('/js/ui-action.js');
      const response = await createMcpRequests()('resolve-action-link', { ref }, { signal: new AbortController().signal, timeoutMs: 10000 });
      return response.kind === 'payload' && !response.isError ? parseDraft(response.payload, ref) : null;
    }, ref);
    if (!independent) throw insufficient('Independent contract-checked read unavailable');
    assert.equal(independent.kind, 'reply_draft');
    assert.equal(independent.id, proposalId);
    assert.equal(await page.locator('[data-draft-subject]').textContent(), independent.subject || 'Reply draft');
    assert.equal(await page.locator('.action-link-message').textContent(), independent.body);
    assert.equal(await page.locator('[data-draft-to]').textContent(), `To: ${independent.to.join(', ')}`);
    assert.equal(await page.locator('[data-draft-cc]').textContent(), `CC: ${independent.cc.join(', ')}`);
    stage = 'foreign refusal';
    await page.goto(`${origin}/a/${foreignRef}?mode=live`);
    await page.waitForFunction(() => document.querySelector('#actionLink') && !document.querySelector('#actionLink').textContent.includes('Opening draft'));
    if (await page.getByText('Sign in to open this draft', { exact: true }).count()) throw insufficient('Partner session expired');
    assert.equal(await page.locator('[data-proposal-id], .action-link-message').count(), 0, 'foreign reference exposes no private review');
    assert.equal(await page.locator('#actionLink [role="status"]').textContent(), 'This draft is unavailable for your account.', 'exact foreign refusal');
    assert.equal(await page.getByRole('button', { name: 'Submit reply for sending', exact: true }).count(), 0);
    assert.equal(violation, undefined);
    assert.deepEqual(await readAppRelease(origin, get), release, 'stable containing release');
    return { status: 'passed', evidence: 'natural-signed-in-read-only', release, assertions: ['exact-proposal', 'exact-content-and-recipients', 'foreign-ref-refused', 'zero-writes'], requests };
  } finally {
    clearTimeout(timer);
    lifetime.abort();
    if (browser) await browser.close();
    else if (acquisition) await acquisition.then(value => value.close(), () => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, commit: { type: 'string' }, ref: { type: 'string' }, 'proposal-id': { type: 'string' }, 'foreign-ref': { type: 'string' }, 'cdp-url': { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' } } });
    const url = new URL(values.origin), timeoutMs = Number(values['timeout-ms']);
    assert.ok(url.href === url.origin + '/' && !url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
    console.log(JSON.stringify(await prove({ origin: url.origin, commit: values.commit, ref: values.ref, proposalId: values['proposal-id'], foreignRef: values['foreign-ref'], timeoutMs, engine: values['cdp-url'] ? signedInReplyEngine(values['cdp-url']) : undefined })));
  } catch (error) { console.log(JSON.stringify({ status: error.exitCode === 78 ? 'insufficient_evidence' : 'failed', error: error.message })); process.exitCode = error.exitCode || 1; }
}
