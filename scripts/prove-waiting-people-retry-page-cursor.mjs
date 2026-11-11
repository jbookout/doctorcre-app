import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export const assertions = ['first page and team identities', 'failed page retains choices and selection', 'retry uses exact cursor and appends once', 'new query invalidates late retry', 'teardown rejects late page'];
const directory = JSON.parse(readFileSync(new URL('../contracts/people-directory.v1.json', import.meta.url)));
const ajv = new Ajv({ formats: { uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i } });
const validators = Object.fromEntries(Object.entries(directory.verbs).map(([name, verb]) => [name, { request: ajv.compile(verb.request), response: ajv.compile(verb.response) }]));
export const personId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const nextCursor = { query: 'ann', name: 'Ann one', id: personId(1) };
export function checkedDirectory(name, kind, value) {
  assert.equal(validators[name][kind](value), true, JSON.stringify(validators[name][kind].errors));
  return value;
}
export function inboxFixture() {
  return { ok: true, schema_version: 'home-inbox.v5', truncated: false, limit: 1000, working_collapsed: true, auto_settle_enabled: true, items: [{
    item_id: 'retry-proof', source_type: 'next_action', source_id: personId(50), source_version: 'synthetic:1', source_state: 'needs_attention', title: 'Synthetic waiting page proof', activity_at: '2026-01-01T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'synthetic:1', waiting_version: 0, waiting_on: null, completed_at: null, auto_settled: false, context_label: 'Synthetic proof', due_on: null, open_url: null, kind_label: 'Task', merged_source_ids: [], action_id: personId(50), action_version: 1, deal_id: null,
  }] };
}
class Unavailable extends Error {}
export async function runProof({ origin: originText, timeout = 30000, engine = chromium, viewport = { width: 1440, height: 900 }, theme = 'light', screenshot }) {
  const origin = new URL(originText);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw Error('Invalid origin or timeout-ms');
  let browser, timer, requests = 0, bytes = 0, releasePending, rejectAsset;
  const assetFailure = new Promise((_, reject) => { rejectAsset = reject; });
  const abort = new AbortController();
  const deadline = performance.now() + timeout;
  const expired = new Unavailable('Proof deadline exceeded; release or behavior witness unavailable');
  const remaining = () => {
    if (performance.now() >= deadline) abort.abort(expired);
    abort.signal.throwIfAborted();
    return Math.max(1, Math.ceil(deadline - performance.now()));
  };
  const assets = new Map(), errors = [], searches = [];
  let failure = true, hold = false, maxActive = 0, active = 0;
  const receipt = { release: null, assets: [], assertions: [], limitation: 'Deployed synthetic behavior only. No natural business journey or production writes.' };
  const get = async url => {
    remaining();
    if (++requests > 31) throw Error('Fetch count exceeds release plus thirty assets');
    let response;
    try { response = await proofFetch(url, { signal: abort.signal, redirect: 'manual' }); } catch { throw new Unavailable(`Unavailable asset ${url}`); }
    if (!response.ok) throw new Unavailable(`Unavailable asset ${url}, HTTP ${response.status}`);
    const chunks = [];
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 10 * 1024 * 1024) throw Error('Asset byte cap exceeded'); chunks.push(chunk); }
    remaining();
    return Buffer.concat(chunks);
  };
  const run = async () => {
    receipt.release = await readAppRelease(origin, async url => ({ type: 'application/json', body: await get(url) }));
    const acquired = await launchProofBrowser(engine, { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() }, { signal: abort.signal });
    if (performance.now() >= deadline) abort.abort(expired);
    if (abort.signal.aborted) { await acquired.close(); abort.signal.throwIfAborted(); }
    browser = acquired;
    const context = await browser.newContext({ viewport, colorScheme: theme, serviceWorkers: 'block' });
    remaining();
    const page = await context.newPage();
    page.setDefaultTimeout(remaining());
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin.origin) return route.abort();
      if (req.method() === 'GET' && url.pathname === '/inbox') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="homeRoot" data-inbox></main><script type="module" src="/js/ui-inbox.generated.js"></script></body></html>' });
      if (req.method() === 'GET' && url.pathname === '/auth/session') return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-proof' } });
      if (req.method() === 'POST' && url.pathname === '/mcp') {
        const { name, arguments: args } = req.postDataJSON().params;
        let value;
        if (name === 'read-home-inbox-v5') value = inboxFixture();
        else if (name === 'read-actor-roster-v1') value = checkedDirectory(name, 'response', { ok: true, schema_version: 'actor-roster.v1', actors: [{ id: personId(90), slug: 'ann-team', display_name: 'Ann team', kind: 'human' }] });
        else if (name === 'search-parties-v1') {
          checkedDirectory(name, 'request', args);
          if (searches.length >= 12) throw Error('Synthetic search cap exceeded');
          searches.push(structuredClone(args)); active++; maxActive = Math.max(maxActive, active);
          if (hold) await new Promise(resolve => { releasePending = resolve; });
          active--;
          if (args.cursor && failure) { failure = false; value = { error: 'network_error' }; }
          else value = checkedDirectory(name, 'response', { ok: true, schema_version: 'party-search.v1', parties: args.query === 'Bea' ? [{ id: personId(3), display_name: 'Bea three', kind: 'person' }] : [{ id: personId(1), display_name: 'Ann one', kind: 'person' }, ...(args.cursor ? [{ id: personId(2), display_name: 'Ann two', kind: 'person' }] : [])], next_cursor: args.query === 'Bea' || args.cursor ? null : nextCursor });
        } else return route.abort();
        return route.fulfill({ json: { result: { ...(value.error ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] } } });
      }
      if (req.method() !== 'GET' || !/^\/js\/[a-zA-Z0-9_./-]+\.(?:js|mjs)$/.test(url.pathname) || url.pathname.includes('..') || url.search) return route.abort();
      try {
        if (!assets.has(url.href)) { if (assets.size >= 30) throw Error('Asset count cap exceeded'); assets.set(url.href, await get(url)); }
        await route.fulfill({ body: assets.get(url.href), contentType: 'text/javascript' });
      } catch (error) { errors.push(error); rejectAsset(error); await route.abort(); }
    });
    try {
      await page.goto(`${origin.origin}/inbox?mode=live`);
      const row = page.locator('[data-inbox-row="retry-proof"]');
      await row.getByRole('button', { name: 'Set waiting person', exact: true }).click();
      const input = row.getByLabel('Search people by name');
      const person = row.getByLabel('Person', { exact: true });
      const options = () => person.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
      await input.fill('  Ann  ');
      await row.getByRole('button', { name: 'More results', exact: true }).waitFor();
      assert.deepEqual(searches, [{ query: 'Ann', limit: 25 }]);
      assert.deepEqual(await options(), ['', personId(90), personId(1)]); receipt.assertions.push(assertions[0]);
      await person.selectOption(personId(1));
      await row.getByRole('button', { name: 'More results', exact: true }).click();
      await row.getByRole('button', { name: 'Retry search', exact: true }).waitFor();
      assert.deepEqual(await options(), ['', personId(90), personId(1)]); assert.equal(await person.inputValue(), personId(1)); receipt.assertions.push(assertions[1]);
      const failed = structuredClone(searches.at(-1));
      await row.getByRole('button', { name: 'Retry search', exact: true }).click();
      await person.locator(`option[value="${personId(2)}"]`).waitFor({ state: 'attached' });
      assert.deepEqual(searches.at(-1), failed); assert.equal(searches.length, 3); assert.deepEqual(await options(), ['', personId(90), personId(1), personId(2)]); assert.equal(await person.inputValue(), personId(1)); receipt.assertions.push(assertions[2]);
      await input.fill('Ann'); await row.getByRole('button', { name: 'More results', exact: true }).waitFor();
      failure = true;
      await row.getByRole('button', { name: 'More results', exact: true }).click();
      await row.getByRole('button', { name: 'Retry search', exact: true }).waitFor();
      hold = true;
      await row.getByRole('button', { name: 'Retry search', exact: true }).click();
      await page.waitForFunction(() => document.body.textContent.includes('Searching people'));
      await input.fill('Bea');
      hold = false; releasePending?.();
      await person.locator(`option[value="${personId(3)}"]`).waitFor({ state: 'attached' });
      assert.equal(await person.locator(`option[value="${personId(2)}"]`).count(), 0); assert.equal(await person.inputValue(), personId(1)); assert.equal(maxActive, 1); assert.equal(searches.at(-1).cursor, undefined); receipt.assertions.push(assertions[3]);
      if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
      hold = true; releasePending = undefined;
      await input.fill('Ann');
      await row.getByText('Searching people…', { exact: true }).waitFor();
      await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
      hold = false; releasePending?.();
      assert.equal(await page.locator('[data-inbox-row]').count(), 0); receipt.assertions.push(assertions[4]);
      if (errors.length) throw errors[0];
      assert.ok(assets.has(new URL('/js/ui-inbox.generated.js', origin).href));
      receipt.assets = [...assets].map(([url, body]) => ({ url, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length }));
      const result = { ...receipt, network_requests: requests, bytes };
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
      return result;
    } catch (error) { throw errors[0] || error; }
  };
  const deadlineFailure = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(expired); reject(expired); }, timeout); });
  try {
    return await Promise.race([run(), assetFailure, deadlineFailure]);
  } finally { clearTimeout(timer); releasePending?.(); abort.abort(expired); await browser?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' } } });
    console.log(JSON.stringify(await runProof({ origin: values.origin, timeout: Number(values['timeout-ms']) })));
  } catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = error.exitCode || (error instanceof Unavailable ? 78 : 1); }
}
