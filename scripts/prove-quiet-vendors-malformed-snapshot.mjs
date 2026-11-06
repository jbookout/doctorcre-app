import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { init, parse } from 'es-module-lexer';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function assertQuietVendorBehavior(page) {
  return page.evaluate(async () => {
    const { mountQuietVendors } = await import('/js/ui-quiet-vendors.js');
    const assertions = [];
    function check(ok, name) { if (!ok) throw new Error(name); assertions.push(name); }
    const host = document.body.appendChild(document.createElement('div'));
    const row = { subject_type: 'vendor', subject_id: 'synthetic-vendor', ref: 'V-SYNTHETIC', name: 'Synthetic vendor', basis: 'created_at', anchor_on: '2026-01-01', due_on: '2026-02-01', days_overdue: 1 };
    const good = () => ({ cadence: { vendor_days: 14 }, proposals: Array.from({ length: 7 }, (_, i) => ({ ...row, ref: `V-${i}` })).concat({ ...row, subject_type: 'lead', name: 'Hidden lead' }) });
    let reads = 0, resolve, opened;
    const mounted = mountQuietVendors(host, { load: () => { reads++; return new Promise(done => resolve = done); }, href: id => `/vendors?record=${id}`, open: (...args) => opened = args });
    const button = name => [...host.querySelectorAll('button')].find(el => el.textContent === name);
    const wait = async predicate => {
      const end = performance.now() + 3000;
      while (!predicate()) { if (performance.now() >= end) throw new Error('UI transition timed out'); await new Promise(done => setTimeout(done, 10)); }
    };
    const click = async name => { const el = button(name); if (!el) throw new Error(`Missing ${name}`); el.click(); await new Promise(done => setTimeout(done, 0)); };
    const finish = async value => { resolve(value); await wait(() => !button('Loading quiet vendors…')); };
    try {
      check(reads === 0, 'opt-in loading');
      const invalid = [null, {}, { cadence: { vendor_days: 14 }, proposals: [null] },
        { cadence: null, proposals: [] }, { cadence: { vendor_days: '14' }, proposals: [] },
        { cadence: { vendor_days: 0 }, proposals: [] },
        { cadence: { vendor_days: 14 }, proposals: [{ ...row, subject_id: '' }] },
        { cadence: { vendor_days: 14 }, proposals: [row, null] }];
      for (const [index, value] of invalid.entries()) {
        await click(index === 0 ? 'Show quiet vendors' : 'Refresh quiet vendors');
        const before = reads;
        await click('Loading quiet vendors…');
        check(reads === before, `single pending read ${index}`);
        await finish(value);
        check(!!host.querySelector('[role=alert]') && !host.textContent.includes('No quiet vendors'), `malformed refusal ${index}`);
        await click('Hide quiet vendors');
        check(document.activeElement === button('Show quiet vendors'), `refusal Hide focus ${index}`);
        await click('Show quiet vendors');
        check(!!host.querySelector('[role=alert]') && reads === before, `retained refusal ${index}`);
      }
      await click('Refresh quiet vendors'); await finish(good());
      check(host.querySelectorAll('li').length === 5 && !host.textContent.includes('Hidden lead'), 'recovery with five vendor rows');
      await click('Next vendors');
      check(host.querySelectorAll('li').length === 2, 'next page');
      await click('Next vendors');
      check(host.querySelectorAll('li').length === 2, 'last page bounded');
      await click('Previous vendors'); await click('Previous vendors');
      check(host.querySelectorAll('li').length === 5, 'first page bounded');
      host.querySelector('a').click();
      check(opened?.[0].endsWith('/vendors?record=synthetic-vendor') && opened?.[1] === 'quiet-vendor-0', 'navigation and focus-return port');
      await click('Hide quiet vendors');
      check(document.activeElement === button('Show quiet vendors'), 'ready Hide focus');
      const beforeReopen = reads;
      await click('Show quiet vendors');
      check(reads === beforeReopen && host.querySelectorAll('li').length === 5, 'reopen without read');
      await click('Refresh quiet vendors'); await finish({ cadence: { vendor_days: 14 }, proposals: [] });
      check(host.textContent.includes('No quiet vendors in this server snapshot.') && !host.querySelector('[role=alert]'), 'valid empty snapshot');
      await click('Refresh quiet vendors');
      await click('Hide quiet vendors'); await click('Show quiet vendors');
      const beforeDispose = reads;
      await click('Loading quiet vendors…');
      check(reads === beforeDispose, 'pending Hide and reopen keep single read');
      mounted.dispose(); resolve(good());
      await new Promise(done => setTimeout(done, 30));
      check(host.innerHTML === '', 'disposed ignores late read');
      return assertions;
    } finally { mounted.dispose(); host.remove(); }
  });
}

export async function prove({ origin, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let browser, release;
  const assets = new Map(), hashes = [];
  let requests = 0;
  const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });
  async function read(path) {
    if (++requests > 20) throw new Error('Asset request budget exceeded');
    let response;
    try { response = await fetch(new URL(path, origin), { signal: controller.signal, redirect: 'manual' }); }
    catch { if (controller.signal.aborted) throw new Error('Total proof deadline exceeded'); throw unavailable(`Asset unavailable ${path}`); }
    if (response.status !== 200) throw unavailable(`Asset unavailable ${path} (${response.status})`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { controller.abort(); throw new Error('Asset exceeds byte budget'); }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    hashes.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
    return bytes;
  }
  try {
    const releaseBytes = await read('/app-release');
    try { release = JSON.parse(releaseBytes.toString()); } catch { throw unavailable('Release identity missing'); }
    if (!release || typeof release.source_commit !== 'string' || !/^[a-f0-9]{40}$/.test(release.source_commit)) throw unavailable('Release identity missing source_commit');
    await init;
    const pending = ['/js/ui-quiet-vendors.js'];
    while (pending.length) {
      const path = pending.shift();
      if (assets.has(path)) continue;
      const bytes = await read(path);
      assets.set(path, bytes);
      const [imports] = parse(bytes.toString());
      for (const item of imports) {
        if (!item.n) throw new Error('Unresolved module import');
        const url = new URL(item.n, new URL(path, origin));
        if (url.origin !== origin || !/^\/js\/ui-shared-[A-Z0-9]+\.generated\.js$/.test(url.pathname) || url.search || url.hash) throw new Error('Module outside finite asset allowlist');
        if (!assets.has(url.pathname) && !pending.includes(url.pathname)) pending.push(url.pathname);
      }
      if (assets.size + pending.length > 19) throw new Error('Asset request budget exceeded');
    }
    browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() });
    const page = await browser.newPage();
    page.setDefaultTimeout(remaining());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://proof.invalid') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
      const bytes = assets.get(url.pathname);
      return bytes ? route.fulfill({ contentType: 'text/javascript', body: bytes }) : route.abort();
    });
    await page.goto('https://proof.invalid/');
    const assertions = await Promise.race([assertQuietVendorBehavior(page), new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Total proof deadline exceeded')), { once: true });
      if (controller.signal.aborted) reject(new Error('Total proof deadline exceeded'));
    })]);
    if (errors.length) throw new Error(errors.join('; '));
    return { exitCode: 0, release, assets: hashes, assertions };
  } catch (error) { return { exitCode: error.exitCode || 1, release, assets: hashes, error: error.message }; }
  finally { clearTimeout(timer); await browser?.close(); }
}

async function main(args) {
  try {
    if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--timeout-ms') throw new Error('Expected --origin URL --timeout-ms INTEGER');
    const url = new URL(args[1]);
    const timeoutMs = Number(args[3]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid origin or timeout');
    const result = await prove({ origin: url.origin, timeoutMs });
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
