import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export function overdueFixture() {
  const item = (item_id, extra = {}) => ({ item_id, source_type: 'next_action', source_id: '00000000-0000-0000-0000-000000000001', source_version: '1', source_state: 'needs_attention', title: item_id, activity_at: '2026-11-05T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: '1', completed_at: null, auto_settled: false, context_label: 'Synthetic contract fixture', due_on: '2026-11-04', open_url: null, kind_label: 'Task', merged_source_ids: [], action_id: '00000000-0000-0000-0000-000000000001', action_version: 1, deal_id: null, waiting_version: 0, waiting_on: null, ...extra });
  return { ok: true, schema_version: 'home-inbox.v5', truncated: false, limit: 1000, working_collapsed: true, auto_settle_enabled: true, items: [
    item('overdue-task'), item('overdue-call', { source_type: 'capture_post_call_action', kind_label: 'Call follow-up' }),
    item('today-task', { due_on: '2026-11-05' }), item('future-task', { due_on: '2026-11-06' }), item('undated-task', { due_on: null }),
    item('failed-task', { source_state: 'failed' }), item('non-action', { source_type: 'notification', action_id: null, action_version: null, kind_label: 'Update' }),
    item('working-task', { section: 'working', source_state: 'working' }), item('held-task', { section: 'held', hold_until: '2026-11-06T12:00:00Z' }),
    item('snoozed-task', { section: 'snoozed', disposition: 'snoozed', snoozed_until: '2026-11-06T12:00:00Z' }),
    item('settled-task', { section: 'settled', disposition: 'settled' }), item('done-task', { section: 'done', source_state: 'done', completed_at: '2026-11-05T12:00:00Z' }),
    item('auto-settled-task', { section: 'settled', disposition: 'settled', source_state: 'done', auto_settled: true, completed_at: '2026-11-05T12:00:00Z' }),
  ] };
}
const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
export async function prove({ origin, timeoutMs = 30000, engine = chromium }) {
  const base = new URL(origin);
  assert.ok(base.origin === origin && !base.username && !base.password && (base.protocol === 'https:' || base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)), 'origin only');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'bounded timeout');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(unavailable('Proof deadline exceeded')), timeoutMs);
  let browser, requests = 0, bytes = 0, routeFailure;
  const assets = new Map();
  const read = async url => {
    if (++requests > 64) throw unavailable('Request budget exceeded');
    const response = await proofFetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw unavailable(`Asset unavailable ${response.status}`);
    const chunks = [];
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw unavailable('Byte budget exceeded'); chunks.push(chunk); }
    return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '' };
  };
  try {
    const release = await readAppRelease(origin, read);
    browser = await launchProofBrowser(engine, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs }, { signal: controller.signal });
    const context = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'Pacific/Kiritimati' });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.clock.install({ time: new Date('2026-11-05T16:00:00Z') });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (req.method() === 'POST' && url.pathname === '/mcp') {
        const { name, arguments: args } = req.postDataJSON().params;
        if (name !== 'read-home-inbox-v5' || Object.keys(args).length) return route.abort();
        return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(overdueFixture()) }] } } });
      }
      if (req.method() !== 'GET') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="homeRoot" data-inbox></main><script type="module" src="/js/ui-inbox.generated.js"></script>' });
      if (url.pathname === '/auth/session') return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-proof-only' } });
      if (url.pathname === '/js/app-shell.js') return route.fulfill({ contentType: 'text/javascript', body: '' });
      if (!/^\/js\/[a-zA-Z0-9._-]+\.m?js$/.test(url.pathname)) return route.abort();
      try {
        if (!assets.has(url.href)) { const asset = await read(url); assert.match(asset.type, /javascript/); assets.set(url.href, asset.body); }
        return await route.fulfill({ contentType: 'text/javascript', body: assets.get(url.href) });
      } catch (error) { routeFailure = error; await route.abort(); }
    });
    await page.goto(`${origin}/?mode=live`);
    await page.waitForFunction(() => document.querySelector('.home-sections') || document.querySelector('[role="alert"]'));
    if (routeFailure) throw routeFailure;
    const overdue = page.getByRole('region', { name: 'Overdue', exact: true });
    assert.equal(await overdue.count(), 1, 'Overdue slice must exist');
    await overdue.getByRole('button', { name: 'See all 2' }).click();
    assert.deepEqual(await overdue.locator('[data-inbox-row]').evaluateAll(nodes => nodes.map(n => n.dataset.inboxRow)), ['overdue-task', 'overdue-call']);
    for (const name of ['Needs your attention', 'Today']) assert.equal(await page.getByRole('region', { name, exact: true }).locator('[data-inbox-row^="overdue-"]').count(), 0);
    assert.ok(await overdue.innerText().then(text => text.includes('2026-11-04')));
    await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
    await page.locator('.home-sections').waitFor({ state: 'detached' });
    const after = await readAppRelease(origin, read); assert.deepEqual(after, release, 'Stable app release');
    return { ok: true, deployed_asset_fixture: { status: 'passed', parser: 'read-home-inbox-v5 through production Inbox client', assertion_count: 7 }, natural_acceptance: { status: 'insufficient_evidence', reason: 'Fresh browser has no signed-in natural observation' }, origin, release, requests, assets: [...assets].map(([url, body]) => ({ url, sha256: createHash('sha256').update(body).digest('hex') })) };
  } catch (error) { throw controller.signal.aborted ? controller.signal.reason : routeFailure || error; }
  finally { clearTimeout(timer); controller.abort(unavailable('Proof closed')); await browser?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, help: { type: 'boolean' } } });
    if (values.help) console.log('node scripts/prove-home-overdue-task-slice.mjs --origin https://app.doctorcre.com [--timeout-ms 30000]. Bounded GET-only asset observation with synthetic v5 responses. Exit 1 assertion failure; 78 unavailable or natural acceptance insufficient. Fixture success remains natural acceptance insufficient.');
    else { const receipt = await prove({ origin: values.origin, timeoutMs: Number(values['timeout-ms']) }); console.log(JSON.stringify(receipt)); process.exitCode = 78; }
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message, natural_acceptance: { status: 'insufficient_evidence' } })); process.exitCode = error.exitCode || 1; }
}
