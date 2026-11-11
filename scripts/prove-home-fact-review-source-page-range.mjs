import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { init, parse } from 'es-module-lexer';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export function factCases() {
  const id = '00000000-0000-4000-8000-000000000001';
  return [
    ['one-page', 1, 1, true], ['multi-page', 2, 9, true],
    ['maximum', 100000, 100000, true], ['full-range', 1, 100000, true],
    ['expired-excerpt', 2, 9, true, null],
    ['zero-start', 0, 2, false], ['zero-end', 1, 0, false],
    ['negative-start', -1, 2, false], ['negative-end', 1, -1, false],
    ['fraction-start', 1.5, 2, false], ['fraction-end', 1, 2.5, false],
    ['unsafe-start', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1, false],
    ['unsafe-end', 1, Number.MAX_SAFE_INTEGER + 1, false],
    ['reversed', 9, 2, false], ['over-start', 100001, 100001, false], ['over-end', 1, 100001, false],
  ].map(([name, start, end, valid, excerpt = 'Synthetic signed term is 60 months.']) => {
    const reference = { kind: 'fact_review', item_id: name, source_version: 'v1', operations: ['resolve-fact-review'] };
    const detail = { entity_ref: id, fact_key: 'term_months', canonical_version: 0, review_version: 'a'.repeat(64), pending: true,
      reasons: ['human_review'], canonical_fact: null, canonical_history: [], review_history: [],
      observations: [{ id, value: '60', unit: 'months', method: 'human', confidence_tier: 'human_review',
        source: { document_ref: id, page_start: start, page_end: end, cited_text: excerpt } }] };
    return { name, valid, response: { ok: true, schema_version: 'home-review.v1', reference, detail,
      operations: [{ verb: 'resolve-fact-review', decisions: ['approve', 'correct', 'reject'], args: {
        entity_ref: id, fact_key: detail.fact_key, base_version: detail.canonical_version, review_version: detail.review_version } }] },
      row: { waiting_version: 0, waiting_on: null, item_id: name, source_type: 'fact_review', source_id: JSON.stringify([id, detail.fact_key]),
        source_version: reference.source_version, source_state: 'needs_attention', title: `Synthetic ${name}`, activity_at: '2026-11-03T12:00:00Z',
        hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1',
        context_label: null, due_on: null, open_url: null, kind_label: 'Fact review', merged_source_ids: [], action_id: null,
        action_version: null, deal_id: null, auto_settled: false, completed_at: null, review_reference: reference } };
  });
}
export const factSnapshot = cases => ({ ok: true, schema_version: 'home-inbox.v5', auto_settle_enabled: true,
  working_collapsed: true, truncated: false, limit: 1000, items: cases.map(c => c.row) });

export async function exerciseHome(page) {
  const cases = factCases();
  const calls = [];
  let active;
  const assertions = [];
  const check = (name, passed) => { assertions.push({ name, passed }); assert.ok(passed, name); };
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    calls.push({ name, args });
    const selected = cases.find(c => c.name === args.item_id);
    const payload = name === 'read-home-inbox-v5' ? factSnapshot([active])
      : name === 'read-home-review' && selected && args.source_version === selected.row.source_version ? selected.response : { error: 'proof_unexpected_rpc' };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  for (const c of cases) {
    active = c;
    await page.goto('/inbox?mode=live', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-inbox-row]').first().waitFor();
    await page.evaluate(() => { history.replaceState(null, '', '/?mode=live'); dispatchEvent(new PopStateEvent('popstate')); });
    const row = page.locator(`[data-inbox-row="${c.name}"]`);
    await row.getByRole('button', { name: 'Review card', exact: true }).click();
    const panel = page.getByRole('region', { name: `Review Synthetic ${c.name}`, exact: true });
    if (c.valid) {
      await panel.getByLabel('Decision', { exact: true }).waitFor();
      const source = c.response.detail.observations[0].source;
      check(`${c.name} preserves citation`, (await panel.textContent()).includes(`Document ${source.document_ref}, pages ${source.page_start} to ${source.page_end}`));
      check(`${c.name} offers approval`, await panel.getByRole('option', { name: 'Approve a sourced value', exact: true }).count() === 1);
      check(`${c.name} preserves excerpt`, (await panel.locator('blockquote').textContent()) === (source.cited_text || 'Excerpt no longer available'));
    } else {
      await panel.locator('form, [role="status"]').filter({ hasNotText: 'Loading current evidence' }).first().waitFor();
      check(`${c.name} refuses approval`, await panel.locator('form, select, button:has-text("Save review")').count() === 0);
    }
    await panel.getByRole('button', { name: 'Close review', exact: true }).click();
  }
  check('actual inbox v5 read', calls.some(c => c.name === 'read-home-inbox-v5'));
  check('each exact review read', cases.every(c => calls.some(call => call.name === 'read-home-review' && call.args.item_id === c.name && call.args.source_version === c.row.source_version)));
  check('zero mutation RPC requests', calls.every(c => ['read-home-inbox-v5', 'read-home-review'].includes(c.name)));
  return assertions;
}

export async function prove({ origin, timeoutMs }) {
  const receipt = { release: null, releaseAfter: null, assets: [], assertions: [] };
  const controller = new AbortController();
  const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });
  const end = Date.now() + timeoutMs;
  let browser, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(unavailable('total deadline exceeded')); reject(controller.signal.reason); }, timeoutMs); });
  try {
    await Promise.race([deadline, (async () => {
      let requests = 0, bytes = 0;
      const get = async url => {
        if (++requests > 22) throw unavailable('request cap exceeded');
        let response;
        try { response = await proofFetch(url, { signal: controller.signal, redirect: 'error', cache: 'no-store' }); }
        catch { throw unavailable('release or asset unavailable'); }
        if (!response.ok) throw unavailable(`unavailable ${new URL(url).pathname}`);
        const chunks = [];
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) throw unavailable('asset byte cap exceeded');
          chunks.push(chunk);
        }
        return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '' };
      };
      receipt.release = await readAppRelease(origin, get);
      const assets = new Map();
      const pending = ['/js/ui-inbox.generated.js', '/js/boot-mode.js', '/js/private-session.js', '/js/mcp-requests.mjs'].map(p => new URL(p, origin).href);
      await init;
      while (pending.length) {
        if (assets.size >= 20) throw unavailable('twenty asset fetch cap exceeded');
        const url = pending.shift();
        if (assets.has(url)) continue;
        const { body } = await get(url);
        assets.set(url, body);
        receipt.assets.push({ url, sha256: createHash('sha256').update(body).digest('hex') });
        for (const entry of parse(body.toString())[0]) {
          if (entry.d === -2 || !entry.n && entry.d >= 0) continue;
          if (!entry.n) throw unavailable('unresolved static module dependency');
          const dep = new URL(entry.n, url);
          if (dep.origin !== origin || dep.search || dep.hash || !/^\/js\/[a-zA-Z0-9_.-]+\.m?js$/.test(dep.pathname)) throw unavailable('module outside same-origin asset allowlist');
          if (!assets.has(dep.href) && !pending.includes(dep.href)) pending.push(dep.href);
        }
      }
      browser = await launchProofBrowser(chromium, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: Math.max(1, end - Date.now()) }, { signal: controller.signal });
      if (controller.signal.aborted) {
        await browser.close();
        throw unavailable('total deadline exceeded');
      }
      const context = await browser.newContext({ serviceWorkers: 'block', baseURL: origin });
      context.setDefaultTimeout(Math.max(1, Math.min(5000, end - Date.now())));
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/inbox') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><main id="homeRoot" data-inbox></main><script type="module" src="/js/ui-inbox.generated.js"></script></body>' });
        const body = assets.get(url.href);
        return body ? route.fulfill({ contentType: 'text/javascript', body }) : route.abort();
      });
      const page = await context.newPage();
      receipt.assertions = await exerciseHome(page);
      receipt.releaseAfter = await readAppRelease(origin, get);
      assert.deepEqual(receipt.releaseAfter, receipt.release, 'release changed during proof');
    })()]);
    return { ...receipt, status: 'passed', exitCode: 0 };
  } catch (error) {
    const exitCode = error.exitCode === 78 ? 78 : 1;
    if (exitCode === 1) receipt.assertions.push({ name: error.message, passed: false });
    return { ...receipt, status: exitCode === 78 ? 'unavailable' : 'failed', error: error.message, exitCode };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await browser?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string' } } });
    const url = new URL(values.origin);
    const timeoutMs = Number(values['timeout-ms']);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href !== `${url.origin}/` || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('Use --origin <origin> --timeout-ms <1..30000>');
    const result = await prove({ origin: url.origin, timeoutMs });
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.log(JSON.stringify({ status: 'failed', error: error.message, exitCode: 1 }));
    process.exitCode = error.exitCode || 1;
  }
}
