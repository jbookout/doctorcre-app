import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { init, parse } from 'es-module-lexer';

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
export const territoryResponse = JSON.parse(readFileSync(new URL('../test/fixtures/territory-evidence-current-history-view/recordings.json', import.meta.url))).response;

export async function exerciseEvidenceHistory(response) {
  const { mountTerritoryEvidence } = await import('/js/ui-territory-evidence.generated.js');
  const results = [];
  const check = (name, ok) => { if (!ok) throw new Error(name); results.push({ name, passed: true }); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const host = document.createElement('div'); document.body.append(host);
  let payload = structuredClone(response), failure, pending, calls = 0, authorized = 0;
  const view = mountTerritoryEvidence(host, { getTerritoryStateBoard: async () => {
    calls++; if (failure) throw failure; return pending || payload;
  } }, () => authorized++);
  const selector = () => [...host.querySelectorAll('select')].find(el => el.closest('label').textContent.startsWith('Evidence view'));
  const select = async value => {
    check('evidence selector exists', !!selector());
    selector().value = value; selector().dispatchEvent(new Event('change', { bubbles: true })); await settle();
  };
  const open = async () => { host.querySelector('details').open = true; host.querySelector('details').dispatchEvent(new Event('toggle')); await settle(); };
  const rows = () => [...host.querySelectorAll('tbody tr')];
  const ids = () => [...host.querySelectorAll('tbody li')].map(el => el.getAttribute('data-evidence-id'));
  const expected = mode => response.submarkets.flatMap(row => row.evidence.filter(e => mode === 'all' || e.current === (mode === 'current')).map(e => e.flag_id));
  const selectCondition = async value => { const el=host.querySelector('select');el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));await settle(); };
  try {
    check('idle does not read', calls === 0); await open();
    check('load succeeds through production parser', rows().length === response.submarkets.length);
    check('all evidence is the default', selector()?.value === 'all');
    for (const mode of ['all','current','historical','all']) {
      const before = calls; await select(mode);
      check(`${mode} uses only parsed current in producer order`, JSON.stringify(ids()) === JSON.stringify(expected(mode)));
      check(`${mode} causes no read`, calls === before);
      check(`${mode} keeps all areas and conditions`, rows().length === response.submarkets.length && rows().every((row,i)=>row.cells[1].textContent === ({conflicting:'Conflicting',unknown:'Unknown'})[response.submarkets[i].condition]));
      for (const [i,row] of response.submarkets.entries()) {
        const count=row.evidence.filter(e=>mode==='all'||e.current===(mode==='current')).length;
        check(`${mode} count ${row.city}`, rows()[i].textContent.includes(`${count} visible / ${row.evidence.length} total evidence`));
      }
      check(`${mode} retains unknown and conflict explanations`, host.textContent.includes('Unknown means no current evidence; conflicting means current sources disagree.'));
    }
    await select('historical');
    check('nonexpired false remains historical', ids().includes('historical-unexpired') && host.textContent.includes('Historical · not current'));
    check('expired false remains historical', ids().includes('historical-expired') && host.textContent.includes('Historical · expired'));
    check('source dates remain verbatim', host.textContent.includes(response.submarkets[0].evidence[2].observed_at));
    check('unknown empty subset is explicit', rows()[1].textContent.includes('No matching evidence for this view.'));
    await selectCondition('conflicting');
    check('condition filter preserves selection', selector().value === 'historical' && rows().length === 1 && ids().length === 2);
    await view.refresh(); check('refresh preserves selection', selector().value === 'historical');
    host.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();
    check('server filter preserves selection', selector().value === 'historical');
    await selectCondition('unknown');
    check('zero evidence area stays visible', rows().length === 1 && rows()[0].textContent.includes('No matching evidence for this view.'));
    await view.refresh(); check('empty subset refresh retains view', selector().value === 'historical' && rows().length === 1);
    await selectCondition('all');
    failure={code:'territory_board_limit_exceeded'};await view.refresh();failure=undefined;
    check('refusal hides board and retains selection', !rows().length && !!host.querySelector('[role="alert"]') && selector().value==='historical');
    payload=structuredClone(response);payload.submarkets[0].evidence[0].observed_at='2028-02-31T12:00:00Z';await view.refresh();
    check('invalid dates refuse the board', !rows().length && !!host.querySelector('[role="alert"]'));
    payload=structuredClone(response);await view.refresh();check('retry preserves selection',selector().value==='historical'&&rows().length===2);
    let release;pending=new Promise(resolve=>release=resolve);const stale=view.refresh();pending=undefined;
    await view.refresh();release({...response,submarkets:[]});await stale;
    check('newer success retires stale completion',rows().length===2&&selector().value==='historical');
    pending=new Promise(resolve=>release=resolve);const cleared=view.refresh();view.clear();release(response);await cleared;pending=undefined;
    check('clear retires completion and resets',!rows().length&&selector().value==='all');
    await open();await select('current');view.clear();
    check('ready clear resets',selector().value==='all');await open();await select('historical');
    failure={code:'unauthorized'};await view.refresh();failure=undefined;
    check('auth retirement resets',authorized===1&&!rows().length&&selector().value==='all'&&!host.querySelector('details').open);
    await open();await select('current');pending=new Promise(resolve=>release=resolve);const retired=view.refresh();view.dispose();release(response);await retired;
    check('dispose retires pending completion',host.childElementCount===0);
    const second=mountTerritoryEvidence(host,{getTerritoryStateBoard:async()=>response},()=>{});await open();second.dispose();
    check('ready disposal unmounts',host.childElementCount===0);
  } finally { view.dispose();host.remove(); }
  return results;
}

export async function prove({ origin, commit, timeoutMs = 30000, engine = chromium, exercise = exerciseEvidenceHistory }) {
  if (!/^[a-f0-9]{40}$/.test(commit || '') || /^0+$/.test(commit)) throw new Error('Expected a merge commit');
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Expected an origin');
  const assets = new Map(), hashes = [];
  let release, browser, timer;
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0 || controller.signal.aborted) throw unavailable('Total proof timeout');
    return ms;
  };
  const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });
  const work = async () => {
    const fetchBytes = async path => {
      let response;
      try { response = await proofFetch(new URL(path, base), { signal: controller.signal, redirect: 'error' }); }
      catch (error) { if (controller.signal.aborted) throw error; throw unavailable(`Unavailable ${path}`); }
      if (!response.ok) throw unavailable(`Unavailable ${path}`);
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw unavailable('Asset exceeds byte cap'); }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks);
      hashes.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
      return bytes;
    };
    release = await readAppRelease(base, async url => ({ type: 'application/json', body: await fetchBytes(url.pathname) }));
    if (release.source_commit !== commit) {
      try {
        await new Promise((resolve, reject) => {
          let failure;
          const child = execFile('git', ['merge-base', '--is-ancestor', commit, release.source_commit], { timeout: Math.min(remaining(), 5000), signal: controller.signal, killSignal: 'SIGKILL' }, error => { failure = error; });
          child.once('close', () => failure ? reject(failure) : resolve());
        });
      } catch (error) {
        remaining();
        if (error.code === 1) throw unavailable('release commit mismatch');
        throw unavailable('Release ancestry evidence unavailable');
      }
    }
    await init;
    const queue = ['/js/ui-territory-evidence.generated.js'];
    for (let i = 0; i < queue.length; i++) {
      if (queue.length > 19) throw unavailable('Module asset cap exceeded');
      const path = queue[i], bytes = await fetchBytes(path); assets.set(path, bytes);
      for (const entry of parse(bytes.toString('utf8'))[0]) {
        if (entry.d === -2) continue;
        if (!entry.n) throw unavailable('Uninspectable module dependency');
        const url = new URL(entry.n, new URL(path, base));
        if (url.origin !== base.origin || url.search || url.hash || !/^\/js\/ui-shared-[A-Z0-9]+\.generated\.js$/.test(url.pathname)) throw unavailable('Module dependency outside allowlist');
        if (!queue.includes(url.pathname)) queue.push(url.pathname);
      }
    }
    browser = await launchProofBrowser(engine, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() }, { signal: controller.signal });
    if (controller.signal.aborted) { await browser.close(); throw unavailable('Total proof timeout'); }
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base.origin) return route.abort();
      if (url.pathname === '/__territory_proof__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic territory proof</title><body></body>' });
      const bytes = assets.get(url.pathname);
      return bytes ? route.fulfill({ contentType: 'text/javascript', body: bytes }) : route.abort();
    });
    const page = await context.newPage();
    await page.goto(new URL('/__territory_proof__', base).href, { timeout: remaining() });
    const assertions = await page.evaluate(exercise, territoryResponse);
    const after = await readAppRelease(base, async url => ({ type: 'application/json', body: await fetchBytes(url.pathname) }));
    if (after.source_commit !== release.source_commit) throw unavailable('Release changed during observation');
    return { release, after, assets: hashes, assertions, scope: 'deployed_module_fixture', natural: { status: 'insufficient_evidence', reason: 'No existing signed-in app session was observed. Fixture assertions cannot prove natural acceptance.' } };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable('Total proof timeout')); }, timeoutMs);
    })]);
  } catch (error) {
    error.receipt = { release, assets: hashes, assertions: [{ name: error.message, passed: false }] }; throw error;
  } finally { clearTimeout(timer); controller.abort(); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, commit: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, fixture: { type: 'boolean' } } });
    if (!values.origin || !values.commit || !/^\d+$/.test(values['timeout-ms']) || Number(values['timeout-ms']) < 1 || Number(values['timeout-ms']) > 30000) throw new Error('Usage: --origin <origin> --commit <expected-merge> [--timeout-ms <1..30000>] [--fixture]');
    const base = new URL(values.origin);
    if (values.fixture && (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('Fixture success requires a loopback origin');
    const receipt = await prove({ origin: values.origin, commit: values.commit, timeoutMs: Number(values['timeout-ms']) });
    console.log(JSON.stringify(receipt));
    process.exitCode = values.fixture ? 0 : 78;
  } catch (error) { console.log(JSON.stringify(error.receipt || { error: error.message })); process.exitCode = error.exitCode || 1; }
}
