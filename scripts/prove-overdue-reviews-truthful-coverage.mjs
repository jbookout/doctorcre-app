import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { init, parse } from 'es-module-lexer';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function assertCoverage() {
  const { mountDealUpdateReviews } = await import('/js/ui-deal-reviews.generated.js');
  const assertions = [];
  const check = (name, ok) => { assertions.push({ name, passed: Boolean(ok) }); if (!ok) throw Error(name); };
  const container = document.createElement('section'); document.body.append(container);
  const row = { assessment_id: 'synthetic-review', deal_id: 'synthetic-deal', deal_name: 'Synthetic deal', confirm_verb: 'review-deal-update', assessment: { review_required: true, action: { id: 'synthetic-action', description: 'Send terms' }, update: 'Terms sent' } };
  const auto = { assessment_id: 'synthetic-auto', deal_id: 'synthetic-deal', deal_name: 'Synthetic closed', action_title: 'Terms', quote: 'Sent', resolved_at: '2026-10-01', undo_possible: true };
  const result = (proposals = [], automatic_resolutions = []) => ({ schema_version: 'deal-update-reviews.v1', proposals, automatic_resolutions });
  let value = result([null]); let finish; let writes = [];
  const view = mountDealUpdateReviews({ container, client: { readDealUpdateReviews: async () => value, reviewDealUpdate: async request => {
    writes.push(structuredClone(request));
    return { ok: true, decision: request.decision, action_id: writes.length === 1 ? 'wrong' : 'synthetic-action' };
  } }, sourceTime: value => value, readWithDeadline: read => read(), uuidv4: () => 'synthetic-key' });
  const click = action => view.click({ target: container.querySelector('[data-update-action="' + action + '"]') });
  try {
    for (const [name, input, cards] of [
      ['all rejected', result([null]), 0], ['mixed', result([row, null]), 1],
      ['automatic rejected', result([], [null]), 0], ['automatic mixed', result([], [auto, null]), 1],
      ['invalid name', result([{ ...row, deal_name: {} }]), 0],
      ['invalid automatic name', result([], [{ ...auto, deal_name: {} }]), 0],
    ]) {
      value = input; await view.refresh();
      check(name, container.textContent.includes('Some overdue reviews are unavailable') && !container.textContent.includes('No overdue reviews') && container.querySelectorAll('article').length === cards);
      check(name + ' retry', !!container.querySelector('[data-update-action="refresh"]'));
    }
    value = result(); await click('refresh');
    check('retry to empty', container.textContent.includes('No overdue reviews') && !container.textContent.includes('unavailable'));
    value = result([row]); await view.refresh(); await click('resolve');
    check('wrong action receipt stays unknown', container.textContent.includes('unconfirmed'));
    value = result([null]); await view.refresh(); await click('replay');
    check('recovery preserves request', JSON.stringify(writes[0]) === JSON.stringify(writes[1]) && container.textContent.includes('Task marked done'));
    value = result([row], [auto]); await view.refresh();
    const show = container.querySelector('[data-update-action="show"]'); if (show) await view.click({ target: show });
    check('source order', [...container.querySelectorAll('article')].map(n => n.dataset.updateId).join(',') === 'synthetic-review,synthetic-auto');
    value = new Promise(resolve => { finish = resolve; }); const pending = view.refresh();
    window.dispatchEvent(new Event('doctorcre-session-invalidated')); finish(result([row])); await pending;
    check('authorization retirement rejects late read', container.textContent.includes('Sign in') && !container.textContent.includes('Synthetic'));
  } finally { view.dispose(); container.remove(); }
  const host = document.createElement('section'); document.body.append(host);
  const disposed = mountDealUpdateReviews({ container: host, client: { readDealUpdateReviews: () => new Promise(resolve => { finish = resolve; }) }, sourceTime: x => x, readWithDeadline: read => read(), uuidv4: () => 'unused' });
  const pending = disposed.refresh(); disposed.dispose(); finish(result([row])); await pending;
  check('disposal rejects late read', host.textContent === ''); host.remove();
  return assertions;
}

export async function prove({ origin, timeoutMs = 30000 }) {
  const target = new URL(origin);
  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== origin || target.username || target.password || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('Use --origin <origin> --timeout-ms <1..30000>');
  const receipt = { release: null, assets: [], assertions: [], requests: 0 };
  const unavailable = message => Object.assign(Error(message), { unavailable: true });
  const controller = new AbortController(); let browser, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(unavailable('Total deadline exceeded')); reject(controller.signal.reason); void browser?.close(); }, timeoutMs); });
  const started = Date.now();
  try {
    await Promise.race([deadline, (async () => {
      let bytes = 0;
      const get = async url => {
        if (new URL(url).origin !== origin || ++receipt.requests > 10) throw unavailable('Ten-request same-origin cap exceeded');
        let response;
        try { response = await proofFetch(url, { signal: controller.signal, redirect: 'error', cache: 'no-store' }); } catch { throw unavailable('Evidence fetch unavailable'); }
        if (!response.ok) throw unavailable('Evidence HTTP ' + response.status);
        const chunks = [];
        for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw unavailable('Evidence byte cap exceeded'); chunks.push(chunk); }
        return Buffer.concat(chunks);
      };
      let manifest;
      try { receipt.release = await readAppRelease(origin, async url => ({ type: 'application/json', body: await get(url.href) })); manifest = JSON.parse(await get(origin + '/artifact-manifest.json')); }
      catch (error) { if (error.unavailable) throw error; throw unavailable('Malformed release or manifest'); }
      if (manifest?.schema !== 'doctorcre-static-artifact.v1' || manifest.source_commit !== receipt.release.source_commit || !Array.isArray(manifest.files)) throw unavailable('Release/manifest identity unavailable');
      const files = new Map();
      for (const file of manifest.files) {
        if (!file || typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split('/').some(p => p === '..' || p === '.') || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || files.has(file.path)) throw unavailable('Malformed manifest entry');
        files.set(file.path, file);
      }
      const assets = new Map(); const pending = [origin + '/js/ui-deal-reviews.generated.js'];
      await init;
      while (pending.length) {
        const url = pending.shift(); if (assets.has(url)) continue;
        const parsed = new URL(url);
        if (parsed.origin !== origin || parsed.search || parsed.hash || !/^\/js\/[a-zA-Z0-9_.-]+\.js$/.test(parsed.pathname)) throw unavailable('Unadmitted module URL');
        const file = files.get(parsed.pathname.slice(1)); if (!file) throw unavailable('Module absent from manifest');
        const body = await get(url); const sha256 = createHash('sha256').update(body).digest('hex');
        if (sha256 !== file.sha256 || body.length !== file.bytes) throw Error('Manifest asset mismatch');
        assets.set(url, body); receipt.assets.push({ url, sha256 });
        for (const entry of parse(body.toString())[0]) {
          if (entry.d === -2) continue;
          if (!entry.n || !entry.n.startsWith('.')) throw unavailable('Unresolved dependency');
          const dependency = new URL(entry.n, url).href;
          if (!assets.has(dependency) && !pending.includes(dependency)) pending.push(dependency);
          if (assets.size + pending.length > 8) throw unavailable('Asset graph exceeds ten-request cap');
        }
      }
      browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: Math.max(1, timeoutMs - (Date.now() - started)) }, { signal: controller.signal });
      if (controller.signal.aborted) throw unavailable('Deadline exceeded');
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', route => {
        if (route.request().method() !== 'GET') return route.abort();
        const url = route.request().url();
        if (url === origin + '/__coverage-proof') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
        const body = assets.get(url); return body ? route.fulfill({ contentType: 'text/javascript', body }) : route.abort();
      });
      for (const width of [390, 1440]) {
        const page = await context.newPage(); await page.setViewportSize({ width, height: 900 });
        await page.goto(origin + '/__coverage-proof');
        const assertions = await page.evaluate(assertCoverage);
        receipt.assertions.push(...assertions.map(assertion => ({ ...assertion, width })));
        await page.close();
      }
    })()]);
    return { ...receipt, status: 'passed', exitCode: 0 };
  } catch (error) {
    return { ...receipt, status: error.unavailable ? 'unavailable' : 'failed', error: error.message, exitCode: error.unavailable ? 78 : 1 };
  } finally { clearTimeout(timer); controller.abort(); await browser?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' } } });
    const receipt = await prove({ origin: values.origin, timeoutMs: Number(values['timeout-ms']) });
    process.stdout.write(JSON.stringify(receipt) + '\n'); process.exitCode = receipt.exitCode;
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = error.exitCode || 1; }
}
