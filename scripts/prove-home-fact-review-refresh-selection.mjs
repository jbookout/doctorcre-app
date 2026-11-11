import { readFile } from 'node:fs/promises';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

const mailRecordings = JSON.parse(await readFile(new URL('../test/fixtures/mail-priority-panel/recordings.json', import.meta.url)));

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function factFixture(mode = 'replaced', fresh = false) {
  const reference = { kind: 'fact_review', item_id: 'proof-fact', source_version: fresh ? 'v2' : 'v1', operations: ['resolve-fact-review'] };
  const row = { waiting_version: 0, waiting_on: null, item_id: reference.item_id, source_type: 'fact_review', source_id: JSON.stringify([id(1), mode === 'schedule' ? 'rent_schedule' : 'term_months']), source_version: reference.source_version, source_state: 'needs_attention', title: 'Synthetic fact refresh', activity_at: '2026-11-03T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: fresh ? 'opaque:2' : 'opaque:1', context_label: null, due_on: null, open_url: null, kind_label: 'Fact review', merged_source_ids: [], action_id: null, action_version: null, deal_id: null, auto_settled: false, completed_at: null, review_reference: reference };
  const observation = n => ({ id: id(n), value: String(n * 12), unit: 'months', source: { document_ref: id(1), page_start: 1, page_end: 1, cited_text: 'Synthetic signed lease term.' } });
  const observations = !fresh ? [observation(2), observation(3)] : mode === 'empty' || mode === 'correct-empty' || mode === 'no-choice' ? [] : mode === 'retained' || mode === 'correct-retained' ? [observation(2), observation(3)] : mode === 'removed' ? [observation(2)] : [observation(4)];
  const review = { ok: true, schema_version: 'home-review.v1', reference, detail: { canonical_fact: null, observations }, operations: [{ verb: 'resolve-fact-review', args: { entity_ref: id(1), fact_key: mode === 'schedule' ? 'rent_schedule' : 'term_months', base_version: fresh ? 2 : 0, review_version: fresh ? 'r2' : 'r1' }, decisions: fresh && mode === 'forbidden' ? ['reject'] : fresh && mode === 'no-choice' ? ['approve', 'correct'] : ['approve', 'correct', 'reject'] }] };
  return { row, review, snapshot: { ok: true, schema_version: 'home-inbox.v5', auto_settle_enabled: true, working_collapsed: true, truncated: false, limit: 1000, items: [row] } };
}

export async function observeRefresh(page, origin, mode = 'replaced') {
  const calls = [], assertions = [];
  let fresh = false, reads = 0, held, releaseHeld;
  const holding = new Promise(resolve => { releaseHeld = resolve; });
  const check = (condition, name) => { assert.ok(condition, `${mode}: ${name}`); assertions.push(`${mode}: ${name}`); };
  const envelope = (payload, isError = false) => ({ result: { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-proof' } }));
  await page.route(`${origin}/api/v1/intelligence/mail-needs-partner?limit=25`, async route => {
    assert.equal(route.request().method(), 'GET', 'Mail priorities stays read-only');
    await route.fulfill({ json: mailRecordings.empty });
  });
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    calls.push({ name, args });
    if (calls.length > 16) return route.abort();
    const fixture = factFixture(mode, fresh);
    if (name === 'read-home-inbox-v5') return route.fulfill({ json: envelope(fixture.snapshot) });
    if (name === 'read-home-review') {
      reads++;
      if (fresh && mode === 'reload-failure') return route.fulfill({ json: envelope({ error: 'home_review_not_found' }, true) });
      if (fresh && mode === 'disposed') { held = route; await holding; }
      return route.fulfill({ json: envelope(fixture.review) }).catch(() => {});
    }
    if (name === 'resolve-fact-review') {
      if (mode === 'uncertain' && !fresh) { fresh = true; return route.abort(); }
      fresh = true;
      return route.fulfill({ json: envelope({ error: 'version_conflict' }, true) });
    }
    return route.abort();
  });
  try {
    await page.goto(`${origin}/inbox?mode=live`);
    await page.locator('[data-inbox-row="proof-fact"]').waitFor();
    await page.evaluate(() => { history.replaceState(null, '', '/?mode=live'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.getByRole('button', { name: 'Review card', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Review Synthetic fact refresh', exact: true });
    const decision = panel.getByLabel('Decision', { exact: true });
    await decision.waitFor();
    await panel.getByLabel('Choose a sourced value', { exact: true }).selectOption(id(3));
    await panel.getByLabel('Reason', { exact: true }).fill('Keep this reviewed reason');
    if (mode === 'correct-empty' || mode === 'correct-retained') {
      await decision.selectOption('correct');
      await panel.getByLabel('Corrected value', { exact: true }).fill('72');
      await panel.getByLabel('Cited text', { exact: true }).fill('Synthetic corrected term');
    }
    const save = panel.getByRole('button', { name: 'Save review', exact: true });
    await save.click();
    const writes = () => calls.filter(c => c.name === 'resolve-fact-review');
    if (mode === 'uncertain') {
      await panel.getByRole('button', { name: 'Retry same review request', exact: true }).click();
      await panel.getByRole('button', { name: 'Review updated card', exact: true }).waitFor();
      check(JSON.stringify(writes()[0]) === JSON.stringify(writes()[1]), 'uncertain replay retains exact request');
      return assertions;
    }
    await panel.getByRole('button', { name: 'Review updated card', exact: true }).click();
    if (mode === 'disposed') {
      await page.waitForFunction(() => document.body.textContent.includes('Loading the updated card.'));
      for (let attempt = 0; !held && attempt < 100; attempt++) await page.waitForTimeout(10);
      check(!!held, 'reload is in flight');
      await page.goto(`${origin}/__disposed-proof`);
      releaseHeld();
      check(writes().length === 1, 'disposal sends no new request');
      return assertions;
    }
    if (mode === 'reload-failure') {
      await panel.getByText('This card cannot be reviewed here. Open its source record.', { exact: true }).waitFor();
      check(await save.isDisabled(), 'reload failure leaves old evidence unsendable');
      check(writes().length === 1, 'reload failure never submits');
      return assertions;
    }
    await panel.getByText('Updated evidence loaded. Your edits are kept. Review the evidence and recipients before submitting again.', { exact: true }).waitFor();
    check(reads === 2 && writes().length === 1, 'reload never automatically submits');
    check(await panel.getByLabel('Reason', { exact: true }).inputValue() === 'Keep this reviewed reason', 'reason survives reload');
    const fixture = factFixture(mode, true);
    const selected = await decision.inputValue();
    if (mode === 'correct-retained') check(selected === 'correct', 'available correction decision retained');
    const allowed = fixture.review.operations[0].decisions.filter(d => d === 'reject' || fixture.review.detail.observations.length && (d !== 'correct' || fixture.review.operations[0].args.fact_key !== 'rent_schedule'));
    check(allowed.includes(selected) || !allowed.length && selected === '', 'decision belongs to current available operations');
    if (!allowed.length) {
      check(await save.isDisabled(), 'no valid decision disables submission');
      return assertions;
    }
    let visible;
    if (selected === 'approve') {
      visible = await panel.getByLabel('Choose a sourced value', { exact: true }).inputValue();
      check(fixture.review.detail.observations.some(o => o.id === visible), 'visible observation belongs to fresh evidence');
      if (mode === 'retained') check(visible === id(3), 'exact surviving selection retained');
      else check(visible === fixture.review.detail.observations[0].id, 'removed selection visibly defaults');
    }
    await save.click();
    await panel.getByRole('button', { name: 'Review updated card', exact: true }).waitFor();
    check(writes().length === 2, 'only deliberate resubmission writes');
    const submitted = writes()[1].args;
    if (mode === 'correct-retained') check(submitted.correction?.value === '72', 'typed correction survives when still available');
    check(submitted.base_version === 2 && submitted.review_version === 'r2', 'request uses fresh versions');
    check(submitted.decision === selected && submitted.reason === 'Keep this reviewed reason', 'request matches displayed decision and retained reason');
    check(selected === 'approve' ? submitted.observation_id === visible : !('observation_id' in submitted), 'request contains only the displayed current observation');
    return assertions;
  } finally { releaseHeld(); }
}

export async function prove({ origin, timeoutMs }) {
  const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
  const deadline = Date.now() + timeoutMs, controller = new AbortController();
  let browser, assetCount = 0, bytes = 0, routeError, rejectFatal;
  const fatal = new Promise((_, reject) => { rejectFatal = reject; });
  void fatal.catch(() => {});
  const remaining = () => Math.max(1, deadline - Date.now());
  const timer = setTimeout(() => { controller.abort(unavailable('Proof deadline exceeded')); void browser?.close(); }, timeoutMs);
  const get = async url => {
    try {
      const response = await proofFetch(url, { signal: controller.signal, redirect: 'manual' });
      if (!response.ok) throw unavailable(`Evidence unavailable: HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      bytes += body.length;
      if (body.length > 4 * 1024 * 1024 || bytes > 12 * 1024 * 1024) throw Error('Evidence byte budget exceeded');
      return { body, type: response.headers.get('content-type') || '' };
    } catch (error) { if (error.exitCode || error.message.includes('budget')) throw error; throw unavailable('Evidence unavailable or timed out'); }
  };
  try {
    const release = await readAppRelease(origin, get);
    const { chromium } = await import('playwright');
    browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() }, { signal: controller.signal });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const assets = new Map();
    await context.route('**/*', async route => {
      try {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || request.method() !== 'GET') throw Error('Business network refused');
        if (url.pathname === '/inbox') return await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic fact review</title><main id="homeRoot" data-inbox></main><script type="module" src="/js/ui-inbox.generated.js"></script>' });
        if (url.pathname === '/__disposed-proof') return await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Disposed</title>' });
        if (!/^\/js\/[A-Za-z0-9._-]+\.(?:js|mjs)$/.test(url.pathname) || url.search || url.hash) throw Error('Business network refused');
        if (!assets.has(url.href)) {
          if (++assetCount > 20) throw Error('Asset request budget exceeded');
          const value = await get(url.href);
          if (!/javascript/.test(value.type)) throw unavailable('JavaScript asset unavailable');
          assets.set(url.href, value.body);
        }
        await route.fulfill({ contentType: 'text/javascript', body: assets.get(url.href) });
      } catch (error) { routeError = error; rejectFatal(error); await route.abort(); }
    });
    const assertions = [];
    for (const mode of ['replaced', 'empty', 'reload-failure']) {
      const page = await context.newPage();
      page.setDefaultTimeout(remaining());
      page.on('pageerror', error => rejectFatal(error));
      try { assertions.push(...await Promise.race([observeRefresh(page, origin, mode), fatal])); }
      catch (error) { throw routeError || error; }
      finally { await page.close(); }
    }
    if (routeError) throw routeError;
    const final = await readAppRelease(origin, get);
    if (JSON.stringify(final) !== JSON.stringify(release)) throw Error('Release changed during proof');
    return { status: 'passed', release, assets: [...assets].map(([url, data]) => ({ url, sha256: createHash('sha256').update(data).digest('hex') })), assertions, business_network_writes: 0, limitation: 'Deployed synthetic interaction only. Natural signed-in customer journey unproven.' };
  } catch (error) { if (controller.signal.aborted) throw unavailable('Proof deadline exceeded'); throw error; }
  finally { clearTimeout(timer); await browser?.close(); }
}

async function main() {
  try {
    const args = process.argv.slice(2), url = new URL(args[1]), timeoutMs = Number(args[3]);
    if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--timeout-ms' || url.href !== `${url.origin}/` || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('Use --origin HTTPS_OR_LOOPBACK_ORIGIN --timeout-ms 1..30000');
    console.log(JSON.stringify(await prove({ origin: url.origin, timeoutMs })));
  } catch (error) {
    console.log(JSON.stringify({ status: error.exitCode === 78 ? 'unavailable' : 'failed', error: error.message }));
    process.exitCode = error.exitCode || 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
