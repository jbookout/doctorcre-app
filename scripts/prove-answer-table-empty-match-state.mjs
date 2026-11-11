import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { init, parse } from 'es-module-lexer';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

import { readFile } from 'node:fs/promises';
const recordings = JSON.parse(await readFile(new URL('../test/fixtures/answer-table-empty-match-state/recordings.json', import.meta.url)));

export async function assertAnswerTables(recordings) {
  const api = await import('/js/ui-answers.generated.js');
  const assertions = [];
  const check = (name, ok) => {
    assertions.push({name, passed:Boolean(ok)});
    if (!ok) throw new Error(name);
  };
  const host = document.createElement('div');
  document.body.append(host);
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const render = async (blocks, identity = 'answer') => { api.mountAnswerBlocks(host, blocks, identity); await settle(); };
  const filter = async (section, value) => {
    const input = section.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles:true}));
    await settle();
  };
  const click = async (section, text) => {
    const button = [...section.querySelectorAll('button')].find(button => button.textContent === text);
    check(`control ${text}`, Boolean(button));
    button.click(); await settle();
  };
  const rows = section => [...section.querySelectorAll('tbody tr')].map(row => row.textContent);
  const status = section => section.querySelector('[role="status"]')?.textContent;
  try {
    await render(recordings.empty);
    check('empty recorded table message', host.textContent.includes('No recorded rows in this answer'));
    check('empty recorded table live count', status(host) === '0 of 0 rows');
    await filter(host, 'absent');
    check('empty filter remains source empty', host.textContent.includes('No recorded rows in this answer') && !host.textContent.includes('No loaded rows match this filter'));
    await click(host, 'Reset table');
    check('empty reset remains source empty', status(host) === '0 of 0 rows');
    api.disposeAnswerBlocks(host);
    check('empty disposal', host.childNodes.length === 0);
    await render(recordings.populated);
    const original = rows(host);
    check('recorded producer rows rendered', original.length >= 2);
    await click(host, 'Proposed rent ($/SF/year)');
    const sorted = rows(host);
    const sources = [...host.querySelectorAll('.answer-source')].map(node => node.textContent);
    check('sort changes order', JSON.stringify(sorted) !== JSON.stringify(original));
    await filter(host, 's38-absent-cell-value');
    check('local no match message', host.textContent.includes('No loaded rows match this filter'));
    check('local no match live count', status(host) === `0 of ${original.length} rows` && rows(host).length === 0);
    check('message associated with correct table', host.querySelector('.answer-table')?.textContent.includes('No loaded rows match this filter'));
    await click(host, 'Proposed rent ($/SF/year)');
    check('sort while unmatched stays unmatched', status(host) === `0 of ${original.length} rows`);
    await click(host, 'Proposed rent ($/SF/year)');
    await click(host, 'Clear filter');
    check('clear preserves sorted rows', JSON.stringify(rows(host)) === JSON.stringify(sorted));
    check('clear preserves source disclosures', JSON.stringify([...host.querySelectorAll('.answer-source')].map(node => node.textContent)) === JSON.stringify(sources));
    check('clear keeps ascending sort', host.querySelector('[aria-sort="ascending"]') !== null);
    check('clear restores count', status(host) === `${original.length} of ${original.length} rows`);
    host.querySelector('.answer-source summary').click();
    check('source disclosure opens', host.querySelector('.answer-source').open);
    await filter(host, 'Synthetic Alpha');
    check('matching filter', status(host) === `1 of ${original.length} rows`);
    await click(host, 'Reset table');
    check('matching reset clears sort', JSON.stringify(rows(host)) === JSON.stringify(original) && !host.querySelector('[aria-sort="ascending"]'));
    await filter(host, 's38-absent-cell-value');
    await render(recordings.populated);
    check('identical mount preserves no matches', status(host) === `0 of ${original.length} rows`);
    await click(host, 'Reset table');
    check('unmatched reset restores original order', JSON.stringify(rows(host)) === JSON.stringify(original) && host.querySelector('input').value === '');
    const second = structuredClone(recordings.populated[0]); second.id = 'second';
    await render([...recordings.populated, second]);
    const tables = host.querySelectorAll('.answer-table');
    await filter(tables[0], 's38-absent-cell-value');
    check('independent tables', status(tables[0]) === `0 of ${original.length} rows` && rows(tables[1]).length === original.length && !tables[1].textContent.includes('No loaded rows match'));
    await filter(tables[1], 'Synthetic Alpha');
    await click(tables[0], 'Clear filter');
    check('independent clear', rows(tables[0]).length === original.length && rows(tables[1]).length === 1);
    await filter(tables[0], 's38-absent-cell-value');
    await render(recordings.populated, 'replacement');
    check('identity replacement resets local filter', rows(host).length === original.length && host.querySelector('input').value === '');
    await filter(host, 's38-absent-cell-value');
    const changed = structuredClone(recordings.populated); changed[0].rows.reverse();
    await render(changed, 'replacement');
    check('content replacement resets local filter', rows(host).length === original.length && host.querySelector('input').value === '');
    await render([{type:'html',id:'invalid'}]);
    check('invalid block refuses table', host.textContent === 'Interactive answer unavailable' && !host.querySelector('table'));
    await render(recordings.populated);
    check('valid replacement after invalid', rows(host).length === original.length);
    await render([{type:'html',id:'invalid'}]);
    api.disposeAnswerBlocks(host);
    check('invalid disposal', host.childNodes.length === 0);
    await render(recordings.populated);
    check('valid remount', rows(host).length === original.length);
    api.disposeAnswerBlocks(host);
    check('matching disposal', host.childNodes.length === 0);
    await render(recordings.populated);
    await filter(host, 's38-absent-cell-value');
    api.disposeAnswerBlocks(host); api.disposeAnswerBlocks(host);
    check('unmatched disposal idempotent', host.childNodes.length === 0);
    return assertions;
  } finally { api.disposeAnswerBlocks(host); host.remove(); }
}

export async function prove({ origin, timeoutMs = 30000, fixture = false, engine = chromium }) {
  const started = Date.now();
  const receipt = { release: null, assets: [], assertions: [] };
  let browser;
  let timer;
  const controller = new AbortController();
  const unavailable = message => Object.assign(new Error(message), { unavailable: true });
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(unavailable('total deadline exceeded')); reject(controller.signal.reason); }, timeoutMs);
  });
  try {
    await Promise.race([deadline, (async () => {
      let requests = 0;
      let bytes = 0;
      const get = async url => {
        if (++requests > 20) throw unavailable('twenty-fetch cap exceeded');
        let response;
        try { response = await proofFetch(url, { signal: controller.signal, redirect: 'error', cache: 'no-store' }); }
        catch { throw unavailable('asset fetch unavailable'); }
        if (!response.ok) throw unavailable(`asset unavailable ${new URL(url).pathname}`);
        const chunks = [];
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) throw unavailable('asset byte cap exceeded');
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      };
      receipt.release = await readAppRelease(origin, async url => ({ type: 'application/json', body: await get(url.href) }));
      const assets = new Map();
      const pending = [`${origin}/js/ui-answers.generated.js`];
      await init;
      while (pending.length) {
        const url = pending.shift();
        if (assets.has(url)) continue;
        const contents = await get(url);
        assets.set(url, contents);
        receipt.assets.push({ url, sha256: createHash('sha256').update(contents).digest('hex') });
        for (const entry of parse(contents.toString())[0]) {
          if (entry.d === -2) continue;
          if (!entry.n) throw unavailable('unresolved module dependency');
          const dependency = new URL(entry.n, url);
          if (dependency.origin !== origin || dependency.search || dependency.hash || !/^\/js\/[a-zA-Z0-9_-]+\.generated\.js$/.test(dependency.pathname)) throw unavailable('module outside generated asset allowlist');
          if (!assets.has(dependency.href) && !pending.includes(dependency.href)) pending.push(dependency.href);
          if (assets.size + pending.length > 19) throw unavailable('twenty-fetch cap exceeded');
        }
      }
      browser = await launchProofBrowser(engine, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: Math.max(1, timeoutMs - (Date.now() - started)) }, { signal: controller.signal });
      if (controller.signal.aborted) { await browser.close(); throw unavailable('total deadline exceeded'); }
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url === `${origin}/__answer-proof`) return route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'});
        const body = assets.get(url);
        return body ? route.fulfill({contentType:'text/javascript',body}) : route.abort();
      });
      const page = await context.newPage();
      await page.goto(`${origin}/__answer-proof`);
      receipt.assertions = await page.evaluate(assertAnswerTables, recordings);
    })()]);
    return { ...receipt, status: fixture ? 'fixture_passed' : 'insufficient_evidence', natural: 'Signed-in natural answer and read count require separate authorized audit', exitCode: fixture ? 0 : 78 };
  } catch (error) {
    if (!error.unavailable) receipt.assertions.push({name:error.message,passed:false});
    return { ...receipt, status: error.unavailable || error.exitCode === 78 ? 'insufficient_evidence' : 'failed', error: error.message, exitCode: error.unavailable || error.exitCode === 78 ? 78 : 1 };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await browser?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: {type:'string'}, 'timeout-ms': {type:'string',default:'30000'}, fixture: {type:'boolean',default:false} } });
    const url = new URL(values.origin);
    const timeoutMs = Number(values['timeout-ms']);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.href !== `${url.origin}/` || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Use --origin <origin> --timeout-ms <1..30000>');
    if (values.fixture && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Fixtures require loopback origin');
    const result = await prove({origin:url.origin,timeoutMs,fixture:values.fixture});
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.log(JSON.stringify({status:'failed',error:error.message,exitCode:1}));
    process.exitCode = error.exitCode || 1;
  }
}
