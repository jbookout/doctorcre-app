import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { init, parse } from 'es-module-lexer';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { createFixtureClient } from '../js/fixture-client.js';
import { createLiveClient } from '../js/live-client.js';

export async function syntheticBoard(overrides = {}) {
  const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/mcp_read_contracts/read-home-agenda.json', import.meta.url)));
  const seed = await readFile(new URL('../data/board-seed.json', import.meta.url));
  const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${seed.toString('base64')}` });
  const snapshot = await fixture.getHomeAgenda();
  const deals = snapshot.deals.slice(0, 4).map((deal, i) => ({
    ...Object.fromEntries(contract.response.deal_keys.map(key => [key, deal[key] ?? null])),
    id: `synthetic/${i}?`, name: `Synthetic deal ${i}`, owner: i === 2 ? 'dell' : i === 3 ? null : 'joe',
    phase: 'Negotiation', last_touch: ['2026-02-31', '2028-02-29', null, '2026-03-01'][i],
    short_name: `Synthetic ${i}`, item_schema_version: 'deal-items.v1', items: [], needs_next_action: true,
    ...(i === 0 ? overrides : {}),
  }));
  const payload = { schema_version: contract.response.schema_version, actor: 'joe', deals, missing_next_action: [
    { owner: 'joe', deal_ids: deals.slice(0, 2).map(d => d.id) },
    { owner: 'dell', deal_ids: [deals[2].id] }, { owner: null, deal_ids: [deals[3].id] },
  ] };
  assert.deepEqual(Object.keys(payload).sort(), [...contract.response.keys].sort());
  for (const deal of deals) assert.deepEqual(Object.keys(deal).sort(), [...contract.response.deal_keys].sort());
  const client = createLiveClient({ fetchImpl: async (_url, request) => {
    const rpc = JSON.parse(request.body);
    assert.equal(rpc.params.name, 'read-home-agenda');
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  } });
  return client.getHomeAgenda();
}

export async function exerciseHomeDates(board) {
  const { mountMissingNextStep } = await import('/js/ui-next-step.generated.js');
  const results = [];
  const check = (name, condition) => { if (!condition) throw Error(name); results.push({ name, passed: true }); };
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const host = document.createElement('main'); document.body.append(host);
  const view = mountMissingNextStep(host, { joe: 'Joe', dell: 'Dell' });
  const update = async scope => { view.update(board, scope); await settle(); };
  let disposed = false;
  try {
    await update('team');
    check('collapsed shows one deal per owner', host.querySelectorAll('a').length === 3);
    check('impossible date unavailable without Mar 3', host.textContent.includes('Last touch unavailable') && !host.textContent.includes('Mar 3'));
    check('explicit missing date differs', host.textContent.includes('No last touch'));
    check('owner groups and phase retained', host.querySelectorAll('[role="group"]').length === 3 && host.textContent.includes('Negotiation'));
    const toggle = host.querySelector('button'); toggle.focus(); toggle.click(); await settle();
    check('expanded shows all and retains focus', host.querySelectorAll('a').length === 4 && document.activeElement === toggle && toggle.getAttribute('aria-expanded') === 'true');
    check('valid leap date formatted without timezone shift', host.textContent.includes('Last touch Feb 29'));
    check('links and names retained', [...host.querySelectorAll('a')].every(link => board.deals.some(deal => link.getAttribute('href') === `/deals?deal=${encodeURIComponent(deal.id)}&focus=next-step` && link.textContent.includes(deal.name))));
    await update('mine');
    check('expanded mine keeps own and unassigned', host.querySelectorAll('a').length === 3 && !host.textContent.includes('Dell'));
    host.querySelector('button').click(); await settle();
    check('show less collapses', host.querySelectorAll('a').length === 2 && host.querySelector('button').getAttribute('aria-expanded') === 'false');
    await update('team'); check('collapsed team restores owners', host.querySelectorAll('a').length === 3);
    const first = board.deals[0];
    for (const [value, text] of [
      ['2028-02-29', 'Last touch Feb 29'], [null, 'No last touch'], ['2026-02-31', 'Last touch unavailable'],
      ['2026-03-01', 'Last touch Mar 1'], ['2025-02-29', 'Last touch unavailable'], ['1900-02-29', 'Last touch unavailable'],
      ['2000-02-29', 'Last touch Feb 29'], ['2026-00-01', 'Last touch unavailable'], ['2026-01-00', 'Last touch unavailable'],
      ['', 'Last touch unavailable'], [0, 'Last touch unavailable'], [false, 'Last touch unavailable'],
      ['2026-02-28T23:00:00-06:00', 'Last touch unavailable'], ['2026-02-28junk', 'Last touch unavailable'],
    ]) {
      first.last_touch = value; await update('team');
      check(`refresh date ${JSON.stringify(value)}`, host.querySelector('a div span')?.textContent === text);
    }
    board.missing_next_action = []; await update('team'); check('collapsed empty hides panel', host.childElementCount === 0);
    board.missing_next_action = [{ owner: 'joe', deal_ids: board.deals.slice(0, 2).map(d => d.id) }];
    await update('team'); check('empty recovers collapsed', host.querySelectorAll('a').length === 1);
    host.querySelector('button').click(); await settle();
    board.missing_next_action = []; await update('team'); check('expanded empty hides panel', host.childElementCount === 0);
    board.missing_next_action = [{ owner: 'joe', deal_ids: board.deals.slice(0, 2).map(d => d.id) }];
    await update('team'); check('empty recovers expanded', host.querySelectorAll('a').length === 2);
    board.missing_next_action = []; await update('team');
    view.dispose(); disposed = true; check('empty dispose removes island', host.childElementCount === 0);
  } finally { if (!disposed) view.dispose(); host.remove(); }
  for (const expanded of [false, true]) {
    const host = document.createElement('main'); document.body.append(host);
    const view = mountMissingNextStep(host, {});
    board.missing_next_action = [{ owner: 'joe', deal_ids: board.deals.slice(0, 2).map(d => d.id) }];
    view.update(board, 'team'); await settle();
    if (expanded) { host.querySelector('button').click(); await settle(); }
    view.dispose(); check(`${expanded ? 'expanded' : 'collapsed'} dispose removes island`, host.childElementCount === 0); host.remove();
  }
  return results;
}

const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
export function options(args) {
  const { values } = parseArgs({ args, options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, help: { type: 'boolean' } } });
  if (values.help) return { help: true };
  const base = new URL(values.origin);
  assert.ok(base.protocol === 'https:' || base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
  assert.equal(base.href, `${base.origin}/`);
  const timeoutMs = Number(values['timeout-ms']);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000);
  return { origin: base.origin, timeoutMs };
}

export async function prove({ origin, timeoutMs }) {
  const assets = new Map(), hashes = [];
  const controller = new AbortController();
  let browser, timer, release, requests = 0, assertions = [];
  const read = async url => {
    if (++requests > 22) throw unavailable('Request cap exceeded');
    let response;
    try { response = await proofFetch(url, { signal: controller.signal, redirect: 'error', cache: 'no-store' }); }
    catch { throw unavailable('Release or asset unavailable'); }
    if (!response.ok) throw unavailable(`Unavailable ${new URL(url).pathname}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw unavailable('Asset byte cap exceeded');
      chunks.push(chunk);
    }
    return { type: response.headers.get('content-type') || '', body: Buffer.concat(chunks) };
  };
  const work = async () => {
    release = await readAppRelease(origin, read);
    await init;
    const queue = ['/js/ui-next-step.generated.js'];
    for (let i = 0; i < queue.length; i++) {
      if (controller.signal.aborted) throw unavailable('Proof deadline exceeded');
      if (queue.length > 20) throw unavailable('Asset cap exceeded');
      const path = queue[i], response = await read(new URL(path, origin));
      if (!/javascript/.test(response.type)) throw unavailable('Asset is not JavaScript');
      assets.set(path, response.body);
      hashes.push({ path, sha256: createHash('sha256').update(response.body).digest('hex') });
      for (const entry of parse(response.body.toString())[0]) {
        if (entry.d === -2) continue;
        if (!entry.n) throw unavailable('Uninspectable dependency');
        const url = new URL(entry.n, new URL(path, origin));
        if (url.origin !== origin || url.search || url.hash || !/^\/js\/ui-shared-[A-Z0-9]+\.generated\.js$/.test(url.pathname)) throw unavailable('Dependency outside generated chunk allowlist');
        if (!queue.includes(url.pathname)) queue.push(url.pathname);
      }
    }
    const board = await syntheticBoard();
    const launched = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs });
    if (controller.signal.aborted) { await launched.close(); throw unavailable('Proof deadline exceeded'); }
    browser = launched;
    const context = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'America/Los_Angeles' });
    context.setDefaultTimeout(timeoutMs);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') return route.abort();
      if (url.pathname === '/__home_dates_proof__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic Home date proof</title>' });
      const bytes = assets.get(url.pathname);
      return bytes ? route.fulfill({ contentType: 'text/javascript', body: bytes }) : route.abort();
    });
    const page = await context.newPage();
    await page.goto(`${origin}/__home_dates_proof__`);
    assertions = await page.evaluate(exerciseHomeDates, board);
    const after = await readAppRelease(origin, read);
    assert.deepEqual(after, release, 'Release changed during proof');
    return { release, assets: hashes, assertions, requests, scope: 'Deployed synthetic behavior only. No signed-in customer journey.' };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable('Proof deadline exceeded')); }, timeoutMs); })]);
  } catch (error) {
    error.receipt = { release, assets: hashes, assertions: [...assertions, { name: error.message, passed: false }], requests }; throw error;
  } finally { clearTimeout(timer); controller.abort(); await browser?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = options(process.argv.slice(2));
    if (parsed.help) console.log('Usage: node scripts/prove-home-next-step-touch-date-integrity.mjs --origin <origin> --timeout-ms <1..30000>\nExits 0 passed, 1 contradiction or invalid arguments, 78 unavailable.');
    else console.log(JSON.stringify(await prove(parsed)));
  } catch (error) { console.log(JSON.stringify(error.receipt || { error: error.message })); process.exitCode = error.exitCode || 1; }
}
