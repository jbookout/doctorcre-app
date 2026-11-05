import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function exerciseQueueMenu() {
  const { createBriefQueueView } = await import('/js/ui-queue.js');
  const results = [];
  const check = (id, condition) => {
    if (!condition) throw new Error(id);
    results.push({ id, passed: true });
  };
  const menu = document.createElement('nav');
  const content = document.createElement('main');
  document.body.append(menu, content);
  const view = createBriefQueueView(menu, content);
  const today = () => menu.querySelector('[data-brief-queue=today]')?.textContent;
  try {
    const malformed = [null, undefined, {}, { today: null },
      ...[null, {}, 'bad', 2].map(items => ({ today: { items, total: 1 } })),
      ...[undefined, null, '0', -1, 0.5, NaN, Infinity, 9007199254740992].map(total => ({ today: { items: [], total } })),
      { today: { items: [{}], total: 0 } }];
    for (const [index, sections] of malformed.entries()) {
      view.renderMenu({ sponsor: 'joe', sections });
      check(`unknown-${index}`, menu.querySelectorAll('button').length === 4 && today()?.includes('coverage unknown')
        && !menu.textContent.includes('0 of 0') && !menu.textContent.includes('No eligible work'));
      view.renderMenu({ sponsor: 'joe', sections }, 'loops');
      check(`switch-${index}`, menu.querySelector('select')?.value === 'loops');
      view.renderMenu({ sponsor: 'joe', sections });
      check(`back-${index}`, menu.querySelectorAll('button').length === 4);
      view.renderMenu({ sponsor: 'joe', sections: { today: { items: [{}], total: 3 }, loops: { items: [], total: 0 } } });
      check(`recovery-${index}`, today() === 'Today queue · 1 of 3'
        && menu.querySelector('[data-brief-queue=loops]')?.textContent === 'Open loops · 0 of 0');
    }
    for (const [state, suffix] of [['empty', ''], ['partial', ' · Some sources are unavailable'], ['unavailable', ' · Unavailable']]) {
      view.renderMenu({ sponsor: 'joe', sections: { today: { state, items: [], total: 0, total_scope: state === 'empty' ? 'all' : 'available_sources' } } });
      check(`zero-${state}`, today() === `Today queue · 0 of 0${state === 'empty' ? '' : ' from available sources'}${suffix}`);
      view.renderMenu({ sponsor: 'joe', sections: { today: { state, items: null, total: 0 } } });
      check(`unknown-${state}`, today() === `Today queue · coverage unknown${suffix}`);
    }
    view.renderMenu({ sponsor: 'dell', sections: null });
    check('joe-only', menu.querySelectorAll('button').length === 3 && !menu.querySelector('[data-brief-queue=needs_joe]'));
    view.renderMenu({ sponsor: 'dell', sections: null }, 'loops');
    check('joe-only-switch', !menu.querySelector('option[value=needs_joe]'));
    view.dispose();
    check('teardown', menu.childElementCount === 0 && content.childElementCount === 0);
    const second = createBriefQueueView(menu, content);
    second.renderMenu({ sponsor: 'joe', sections: null });
    second.dispose();
    check('unknown-teardown', menu.childElementCount === 0);
    for (const [count, total] of [[0, 0], [1, 3]]) {
      const accurate = createBriefQueueView(menu, content);
      try {
        accurate.renderMenu({ sponsor: 'joe', sections: null });
        accurate.renderMenu({ sponsor: 'joe', sections: { today: { items: Array(count).fill({}), total } } });
        accurate.renderList({ active: 'today', items: [], page: { total: 0, has_more: false, state: 'empty' }, busy: false, error: false });
        check(`accurate-mounted-${count}-${total}`, today() === `Today queue · ${count} of ${total}`
          && menu.querySelectorAll('button').length === 4 && content.childElementCount > 0);
        accurate.dispose();
        check(`accurate-menu-teardown-${count}-${total}`, menu.childElementCount === 0);
        check(`accurate-content-teardown-${count}-${total}`, content.childElementCount === 0);
      } finally { accurate.dispose(); }
    }
    return results;
  } finally { view.dispose(); menu.remove(); content.remove(); }
}

export async function prove({ origin, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  let browser;
  let timer;
  const report = { release: null, assets: [], assertions: [] };
  const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });
  const remaining = () => Math.max(1, deadline - Date.now());
  const assets = new Map();
  const documentURL = `${origin}/__brief_queue_proof__`;
  let requests = 0;
  const fetchBytes = async url => {
    if (++requests > 20) throw unavailable('asset request cap');
    let response;
    try { response = await fetch(url, { signal: controller.signal, redirect: 'error', cache: 'no-store' }); }
    catch { throw unavailable('asset fetch unavailable'); }
    if (!response.ok) throw unavailable(`asset unavailable ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw unavailable('asset size cap');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    report.assets.push({ url, sha256: createHash('sha256').update(bytes).digest('hex') });
    return bytes;
  };
  const run = async () => {
    try { report.release = JSON.parse((await fetchBytes(`${origin}/app-release`)).toString()); }
    catch { throw unavailable('release unavailable'); }
    if (report.release?.service !== 'doctorcre-app' || !/^[0-9a-f]{40}$/.test(report.release.source_commit)
      || !['production', 'staging', 'fixture'].includes(report.release.environment)) throw unavailable('release identity unavailable');
    await init;
    const pending = [`${origin}/js/ui-queue.js`];
    for (let index = 0; index < pending.length; index++) {
      const url = pending[index];
      const bytes = await fetchBytes(url);
      assets.set(url, bytes);
      const [imports] = parse(bytes.toString());
      for (const entry of imports) {
        if (entry.d === -2) continue;
        if (!entry.n) throw unavailable('unresolved module import');
        const target = new URL(entry.n, url);
        if (target.origin !== origin || target.search || target.hash || !/^\/js\/ui-shared-[A-Z0-9]+\.generated\.js$/.test(target.pathname)) throw unavailable('module outside allowlist');
        if (!pending.includes(target.href)) pending.push(target.href);
        if (pending.length > 19) throw unavailable('module request cap');
      }
    }
    browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() });
    if (controller.signal.aborted) { await browser.close(); throw unavailable('total timeout'); }
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url === documentURL) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
      if (assets.has(url)) return route.fulfill({ contentType: 'text/javascript', body: assets.get(url) });
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(documentURL, { timeout: remaining() });
    report.assertions = await page.evaluate(exerciseQueueMenu);
    return { ...report, exitCode: 0 };
  };
  try {
    return await Promise.race([run(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable('total timeout')); }, timeoutMs);
    })]);
  } catch (error) {
    return { ...report, assertions: [...report.assertions, { id: error.message, passed: false }], exitCode: error.exitCode || 1, error: error.message };
  } finally { clearTimeout(timer); controller.abort(); if (browser) await browser.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--timeout-ms') throw new Error('Expected --origin URL --timeout-ms INTEGER');
  const url = new URL(args[1]);
  const timeoutMs = Number(args[3]);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== args[1] || url.username || url.password
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid origin or timeout');
  const report = await prove({ origin: url.origin, timeoutMs });
  console.log(JSON.stringify(report));
  process.exitCode = report.exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.log(JSON.stringify({ exitCode: 1, error: error.message }));
  process.exitCode = 1;
});
