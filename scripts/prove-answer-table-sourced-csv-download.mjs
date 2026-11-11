import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { init, parse } from 'es-module-lexer';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

import { readFile } from 'node:fs/promises';
const recordings = JSON.parse(await readFile(new URL('../test/fixtures/answer-table-sourced-csv-download/recordings.json', import.meta.url)));

export async function assertSourcedCsv(recordings) {
  const api = await import('/js/ui-answers.generated.js');
  const assertions = [];
  const check = (name, ok) => { assertions.push({name,passed:Boolean(ok)}); if (!ok) throw new Error(name); };
  const parseCsv = text => {
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') { if (quoted && text[i+1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
      else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
      else if (c === '\r' && text[i+1] === '\n' && !quoted) { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
      else cell += c;
    }
    check('CSV closes quotes and terminates rows', !quoted && !cell && !row.length);
    return rows;
  };
  const host = document.createElement('div'); document.body.append(host);
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const render = async (blocks, identity = 'answer') => { api.mountAnswerBlocks(host, blocks, identity); await settle(); };
  const filter = async value => {
    const input = host.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
    input.dispatchEvent(new Event('input',{bubbles:true})); await settle();
  };
  const button = name => [...host.querySelectorAll('button')].find(b => b.textContent === name);
  const downloads = [], acquired = [], revoked = [];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, click = HTMLAnchorElement.prototype.click;
  let failure = '';
  URL.createObjectURL = blob => { if (failure === 'create') throw Error('create failed'); const url = create(blob); acquired.push(url); downloads.push({blob,url}); return url; };
  URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
  HTMLAnchorElement.prototype.click = function() { if (failure === 'click') throw Error('click failed'); downloads.at(-1).filename = this.download; };
  const download = async () => { const b = button('Download visible rows'); check('download action exists', !!b); b.focus(); b.click(); await settle(); return downloads.at(-1); };
  try {
    await render(recordings.populated);
    const original = JSON.stringify(recordings);
    let d = await download();
    let csv = parseCsv(await d.blob.text());
    check('recorded producer rows exported', csv.length === recordings.populated[0].rows.length + 1);
    check('source record identity exported', csv[1].includes('11111111-1111-4111-8111-111111111111'));
    for (const [ri,row] of recordings.populated[0].rows.entries()) {
      for (const [ci,column] of recordings.populated[0].columns.entries()) {
        const cell = row[column.key], source = cell.source;
        const expected = [String(cell.value ?? ''),String(cell.value === null),source ? 'record_id' in source ? 'record' : 'fact' : '', source?.record_id ?? '',source?.fact_id ?? '',String(source?.version ?? '')];
        check(`ordered producer value and provenance row ${ri} column ${column.key}`, JSON.stringify(csv[ri+1].slice(ci*6,ci*6+6)) === JSON.stringify(expected));
      }
    }
    check('fixed filename', d.filename === 'answer-comps.csv');
    check('announces count', host.textContent.includes('Exported 2 rows'));
    check('focus remains on action', document.activeElement === button('Download visible rows'));
    button('Proposed rent ($/SF/year)').click(); await settle();
    await filter('Beta'); d = await download(); csv = parseCsv(await d.blob.text());
    check('visible sorted subset only', csv.length === 2 && csv[1][0] === 'Synthetic Beta');
    await filter('absent-unique'); check('empty subset disabled', button('Download visible rows').disabled && host.textContent.includes('No visible rows to download'));
    button('Clear filter').click(); await settle();
    d = await download(); csv = parseCsv(await d.blob.text());
    check('clear preserves ascending order', csv[1][0] === 'Synthetic Beta');
    button('Reset table').click(); await settle();
    check('reset restores view', host.querySelector('input').value === '' && !host.querySelector('[aria-sort="ascending"]'));
    await filter('Beta'); await render(recordings.populated);
    check('identical refresh preserves selection', host.querySelector('input').value === 'Beta');
    await render(recordings.populated,'replacement');
    check('new selection resets filter', host.querySelector('input').value === '');
    failure = 'create'; await download(); check('acquisition failure copy', host.textContent.includes('Download unavailable. Try again.'));
    failure = 'click'; await download(); check('click failure cleanup', acquired.length === revoked.length);
    failure = ''; await download(); check('retry success', host.textContent.includes('Exported 2 rows'));
    const table = structuredClone(recordings.populated[0]);
    table.columns = [
      {key:'text',label:'=Label',type:'text'}, {key:'other',label:'=Label',type:'text'},
      {key:'number',label:'Number',type:'number'}, {key:'flag',label:'Flag',type:'boolean'}, {key:'date',label:'Date',type:'date'}
    ];
    const fact = {fact_id:'22222222-2222-4222-8222-222222222222',version:7};
    const values = ['雪, "quoted"\r\nline', '', '—', null, '=1+1', '+SUM(A1)', '-danger', '@command', ' \t=1', '\u0000+2', '\u00a0@x'];
    table.rows = values.map(value => ({text:{value,source:fact}, other:{value:'tie'},number:{value:-2.5,source:fact},flag:{value:false},date:{value:'2026-11-01'}}));
    await render([table], 'edge-cases');
    check('edge cases pass production parser', host.querySelectorAll('tbody tr').length === values.length);
    d = await download(); csv = parseCsv(await d.blob.text());
    check('unique indexed headers despite repeated labels', new Set(csv[0]).size === csv[0].length && csv[0].length === 30);
    check('Unicode quotes comma CRLF round trip', csv[1][0] === values[0]);
    check('literal empty vs null', csv[2][0] === '' && csv[2][1] === 'false' && csv[4][0] === '' && csv[4][1] === 'true');
    check('em dash remains literal', csv[3][0] === '—' && csv[3][1] === 'false');
    check('raw negative numeric boolean and ISO date', csv[1][12] === '-2.5' && csv[1][18] === 'false' && csv[1][24] === '2026-11-01');
    check('fact identity version exported', csv[1][4] === fact.fact_id && csv[1][5] === '7');
    check('all formula markers neutralized', csv.slice(5).every(row => row[0].startsWith("'")));
    check('formula label neutralized', csv[0][0].startsWith("'"));
    button('Number').click(); await settle(); d = await download(); csv = parseCsv(await d.blob.text());
    check('stable numeric ties', csv[1][0] === values[0] && csv[2][0] === '');
    const badIdentifier = structuredClone(recordings.populated);
    badIdentifier[0].rows[0].rent.source.record_id = ' \t=UNSAFE';
    await render(badIdentifier);
    check('formula identifier rejected by production parser', !button('Download visible rows') && !host.querySelector('table'));
    await render(recordings.empty); check('empty recorded table disabled', button('Download visible rows').disabled);
    await render([{type:'html',id:'bad'}]); check('invalid block refuses download', !button('Download visible rows') && host.textContent.includes('Interactive answer unavailable'));
    await render(recordings.populated); await download(); await download();
    api.disposeAnswerBlocks(host); api.disposeAnswerBlocks(host);
    check('clear auth retirement disposal', host.childNodes.length === 0);
    await settle(); check('no stale completion after disposal', host.childNodes.length === 0);
    check('every acquired URL revoked exactly once', acquired.length === revoked.length && new Set(revoked).size === revoked.length && acquired.every(u => revoked.includes(u)));
    check('producer data unchanged', original === JSON.stringify(recordings));
    return assertions;
  } finally {
    api.disposeAnswerBlocks(host); host.remove(); URL.createObjectURL = create; URL.revokeObjectURL = revoke;
    HTMLAnchorElement.prototype.click = click;
  }
}

async function observeNaturalCsv(page) {
  const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
  if (!await page.locator('#accountSignOut').count()) throw unavailable('No signed-in session');
  const table = page.locator('.answer-table:visible').filter({ has: page.locator('tbody tr') }).first();
  if (!await table.count()) throw unavailable('No eligible recorded answer table');
  const sorted = table.locator('th[aria-sort=ascending], th[aria-sort=descending]');
  const column = await sorted.count() ? sorted.first() : table.locator('th').first();
  const header = column.locator('button');
  const before = await column.getAttribute('aria-sort');
  const clicksToRestore = before === 'none' ? 0 : 1;
  const originalFilter = await table.locator('input').inputValue();
  const snapshot = () => table.locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].map(cell => ({
    value: [...cell.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(''),
    source: cell.querySelector('.answer-source span')?.textContent || ''
  }))));
  let requests = 0;
  const count = () => requests++;
  page.on('request', count);
  try {
    await header.click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const expected = await snapshot();
    if (!expected.length || !expected.some(row => row.some(cell => cell.source))) throw unavailable('No sourced visible rows');
    const [download] = await Promise.all([page.waitForEvent('download'), table.getByRole('button', { name: 'Download visible rows', exact: true }).click()]);
    const stream = await download.createReadStream();
    if (!stream) throw Error('CSV download unreadable');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) throw Error('CSV download exceeds budget');
      chunks.push(chunk);
    }
    const csv = Buffer.concat(chunks).toString();
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < csv.length; i++) {
      const c = csv[i];
      if (c === '"') { if (quoted && csv[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
      else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
      else if (c === '\r' && csv[i + 1] === '\n' && !quoted) { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
      else cell += c;
    }
    if (quoted || cell || row.length || rows.length !== expected.length + 1) throw Error('CSV row count or framing mismatch');
    for (const [ri, cells] of expected.entries()) {
      if (rows[ri + 1].length !== cells.length * 6) throw Error('CSV column count mismatch');
      for (const [ci, visible] of cells.entries()) {
        const [value, isNull, kind, record, fact, version] = rows[ri + 1].slice(ci * 6, ci * 6 + 6);
        const safeText = /^[\s\u0000-\u001f\u007f-\u009f]*[=+@-]/u.test(visible.value) ? "'" + visible.value : visible.value;
        if (!(isNull === 'true' && value === '' && visible.value === '—') && !(isNull === 'false' && (value === visible.value || value === safeText))) throw Error('CSV ordered raw value mismatch');
        const source = kind === 'record' && !fact && !version ? `Record ${record}` : kind === 'fact' && !record ? `Fact ${fact}, version ${version}` : kind === '' && !record && !fact && !version ? '' : null;
        if (source !== visible.source) throw Error('CSV source identity mismatch');
      }
    }
    if (requests) throw Error('Export added network calls');
    return { rows: expected.length, columns: expected[0].length, added_requests: requests, passed: true };
  } finally {
    page.off('request', count);
    if (before === 'none') await table.getByRole('button', { name: 'Reset table', exact: true }).click();
    else for (let i = 0; i < clicksToRestore; i++) await header.click();
    if (await table.locator('input').inputValue() !== originalFilter) await table.locator('input').fill(originalFilter);
  }
}

export async function prove({ origin, timeoutMs = 30000, fixture = false, engine = chromium, commit, cdpUrl }) {
  const started = Date.now();
  const receipt = { release: null, assets: [], assertions: [] };
  let browser;
  let timer;
  let naturalBrowser;
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
      if (!fixture || commit) {
        try {
          commit ||= await new Promise((resolve, reject) => {
            let failure, output;
            const child = execFile('git', ['log', 'origin/main', '-1', '--format=%H', '--fixed-strings', '--grep=(#767)'], { cwd: new URL('../', import.meta.url), timeout: Math.max(1, Math.min(5000, timeoutMs - (Date.now() - started))), signal: controller.signal, killSignal: 'SIGKILL' }, (error, stdout) => { failure = error; output = stdout; });
            child.once('close', () => failure ? reject(failure) : resolve(output.trim()));
          });
          if (!/^[a-f0-9]{40}$/.test(commit || '')) throw unavailable('PR merge commit unknown');
          await new Promise((resolve, reject) => {
            let failure;
            const child = execFile('git', ['merge-base', '--is-ancestor', commit, receipt.release.source_commit], { cwd: new URL('../', import.meta.url), timeout: Math.max(1, Math.min(5000, timeoutMs - (Date.now() - started))), signal: controller.signal, killSignal: 'SIGKILL' }, error => { failure = error; });
            child.once('close', () => failure ? reject(failure) : resolve());
          });
          receipt.required_commit = commit;
        } catch (error) { throw unavailable(error.code === 1 ? 'Release does not contain required commit' : 'Release ancestry evidence unavailable'); }
      }
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
      await page.evaluate(() => import('/js/ui-answers.generated.js').then(() => {}));
      let exportRequests = 0;
      const countExportRequest = () => exportRequests++;
      page.on('request', countExportRequest);
      try {
        receipt.assertions = await page.evaluate(assertSourcedCsv, recordings);
        receipt.assertions.push({ name: 'zero business or network calls', passed: exportRequests === 0 });
        if (exportRequests) throw Error('Export added network calls');
      } finally { page.off('request', countExportRequest); }
      if (!fixture) {
        if (!cdpUrl) throw unavailable('No signed-in browser session supplied; deployed fixture assertions passed');
        naturalBrowser = await launchProofBrowser({ launch: options => engine.connectOverCDP(cdpUrl, {...options, isLocal: true}) }, { timeout: Math.max(1, timeoutMs - (Date.now() - started)) }, { signal: controller.signal });
        const pages = naturalBrowser.contexts().flatMap(context => context.pages()).filter(page => new URL(page.url()).origin === origin);
        if (pages.length !== 1) throw unavailable('Exactly one existing same-origin signed-in page required');
        receipt.natural = await observeNaturalCsv(pages[0]);
      }
      receipt.releaseAfter = await readAppRelease(origin, async url => ({ type:'application/json', body:await get(url.href) }));
      if (receipt.release.source_commit !== receipt.releaseAfter.source_commit) throw unavailable('release changed during proof');
    })()]);
    return { ...receipt, status: fixture ? 'fixture_passed' : 'passed', exitCode: 0 };
  } catch (error) {
    if (!error.unavailable && error.exitCode !== 78) receipt.assertions.push({name:error.message,passed:false});
    return { ...receipt, status: error.unavailable || error.exitCode === 78 ? 'insufficient_evidence' : 'failed', error: error.message, exitCode: error.unavailable || error.exitCode === 78 ? 78 : 1 };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await naturalBrowser?.close();
    await browser?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: {type:'string'}, 'timeout-ms': {type:'string',default:'30000'}, fixture: {type:'boolean',default:false}, commit: {type:'string'}, 'cdp-url': {type:'string'} } });
    const url = new URL(values.origin);
    const timeoutMs = Number(values['timeout-ms']);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.href !== `${url.origin}/` || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Use --origin <origin> --timeout-ms <1..30000>');
    if (values.fixture && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Fixtures require loopback origin');
    if (values['cdp-url']) {
      const cdp = new URL(values['cdp-url']);
      if (cdp.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(cdp.hostname) || cdp.username || cdp.password) throw Error('CDP requires a loopback HTTP endpoint');
    }
    const result = await prove({origin:url.origin,timeoutMs,fixture:values.fixture,commit:values.commit,cdpUrl:values['cdp-url']});
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.log(JSON.stringify({status:'failed',error:error.message,exitCode:1}));
    process.exitCode = error.exitCode || 1;
  }
}
