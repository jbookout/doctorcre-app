import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export const opening = '2026-11-01T06:30:00.000Z';
export function snapshot() {
  return { ok: true, schema_version: 'home-inbox.v5', limit: 1000, truncated: false, working_collapsed: true, auto_settle_enabled: true, items: [{
    item_id: 'next_action:00000000-0000-0000-0000-000000000002', source_type: 'next_action', source_id: '00000000-0000-0000-0000-000000000002', source_version: '1', base_version: 'a'.repeat(32), source_state: 'needs_attention', title: 'Synthetic preview task', context_label: null, kind_label: 'Task', due_on: null, open_url: null, activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', section: 'inbox', snoozed_until: null, explicit_unsettle: false, auto_settled: false, completed_at: null, merged_source_ids: [], action_id: '00000000-0000-0000-0000-000000000002', action_version: 1, deal_id: null, waiting_version: 0, waiting_on: null,
  }] };
}

export async function installFixture(page, { time = opening, invalid = false, uncertain = false } = {}) {
  const data = snapshot(), calls = [];
  if (invalid) delete data.items[0].waiting_version;
  await page.clock.setFixedTime(new Date(time));
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-preview' } }));
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    calls.push({ name, args });
    let payload;
    if (name === 'read-home-inbox-v5') payload = data;
    else if (name !== 'snooze-home-inbox') payload = { error: 'unknown_tool' };
    else {
      assert.match(args.idempotency_key, /^[a-f0-9-]{36}$/);
      assert.deepEqual(args.items, data.items.map(({ item_id, base_version }) => ({ item_id, base_version })));
      assert.equal(new Date(args.until).toISOString(), args.until);
      if (uncertain) return route.abort();
      data.items[0] = { ...data.items[0], disposition: 'snoozed', section: 'snoozed', snoozed_until: args.until, base_version: 'b'.repeat(32) };
      payload = { ok: true, schema_version: 'home-inbox-command.v1', results: [{ ok: true, item_id: data.items[0].item_id, item: data.items[0] }] };
    }
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  return calls;
}

export async function observe(page) {
  const opener = page.getByRole('button', { name: 'Snooze', exact: true }).first();
  await opener.click();
  const choices = page.getByRole('dialog').locator('time');
  const endpoints = await choices.evaluateAll(nodes => nodes.map(node => ({ until: node.dateTime, label: node.textContent })));
  assert.deepEqual(endpoints.map(row => row.until), [1, 24].map(hours => new Date(Date.parse(opening) + hours * 3600000).toISOString()));
  assert.match(endpoints[0].label, /Nov 1, 2026.*CST/);
  await page.clock.setFixedTime(new Date(Date.parse(opening) + 30000));
  assert.deepEqual(await choices.evaluateAll(nodes => nodes.map(node => node.dateTime)), endpoints.map(row => row.until));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await opener.evaluate(node => node === document.activeElement), true);
  return endpoints;
}

export async function prove({ origin, timeoutMs = 30000, engine = chromium }) {
  const base = new URL(origin);
  assert.ok(['http:', 'https:'].includes(base.protocol) && base.origin === origin && !base.username && !base.password, 'origin only');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, 'bounded timeout');
  const signal = AbortSignal.timeout(timeoutMs);
  const release = await readAppRelease(origin, { timeoutMs });
  let browser;
  const assets = new Map();
  let bytes = 0;
  try {
    browser = await launchProofBrowser(engine, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs }, { signal });
    const context = await browser.newContext({ timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') return route.abort();
      if (url.pathname === '/inbox') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="homeRoot" data-inbox></main><script type="module" src="/js/ui-inbox.generated.js"></script>' });
      if (!url.pathname.startsWith('/js/') || !/\.m?js$/.test(url.pathname)) return route.abort();
      try {
        if (!assets.has(url.href)) {
          assert.ok(assets.size < 64, 'asset cap');
          const response = await proofFetch(url, { signal });
          assert.ok(response.ok && /javascript/.test(response.headers.get('content-type')), 'JavaScript asset');
          const body = await response.text();
          bytes += Buffer.byteLength(body);
          assert.ok(bytes <= 16 * 1024 * 1024, 'byte cap');
          assets.set(url.href, body);
        }
        return route.fulfill({ contentType: 'text/javascript', body: assets.get(url.href) });
      } catch { return route.abort(); }
    });
    const calls = await installFixture(page);
    await page.goto(`${origin}/inbox?mode=live`);
    const endpoints = await observe(page);
    assert.equal(calls.filter(call => call.name === 'snooze-home-inbox').length, 0);
    const after = await readAppRelease(origin, { timeoutMs });
    assert.equal(after.source_commit, release.source_commit, 'stable app identity');
    return { ok: true, deployed_module: { endpoints, mutation_requests: 0, contract: 'read-home-inbox-v5 through production parser' }, natural: { status: 'insufficient_evidence', reason: 'Fresh browser uses synthetic fixtures. Signed-in natural observation required.' }, release };
  } finally { await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    assert.ok((args.length === 2 || args.length === 4) && args[0] === '--origin' && (args.length === 2 || args[2] === '--timeout-ms'), 'usage: --origin URL [--timeout-ms 30000]');
    console.log(JSON.stringify(await prove({ origin: args[1], timeoutMs: args[3] ? Number(args[3]) : 30000 })));
    process.exitCode = 78;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message, natural: { status: 'insufficient_evidence' } }));
    process.exitCode = error.exitCode || (error.name === 'TimeoutError' ? 78 : 1);
  }
}
