import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function exerciseAgenda(page, assetUrl) {
  await page.evaluate(async asset => {
    const { mountDealRoomAgenda } = await import(asset);
    document.body.innerHTML = '<button id="start"></button><section id="panel" role="dialog"></section><div id="dock"></div>';
    const button = document.querySelector('#start'), panel = document.querySelector('#panel'), dock = document.querySelector('#dock');
    const counts = { open: 0, step: 0 };
    panel.addEventListener('click', event => {
      if (event.target.closest('[data-open-deal]')) counts.open++;
      if (event.target.closest('[data-agenda-step]')) counts.step++;
    });
    const view = mountDealRoomAgenda({ button, panel, dock }, () => {});
    const props = { buttonHidden: false, disabled: false, review: { title: 'Synthetic review', index: 1, total: 3,
      deal: { id: 'synthetic', name: 'Synthetic deal', context: 'Synthetic context', reason: 'Review', phase: 'Research', nextStep: 'Call', nextDate: 'Not set', marketAgent: null } },
      confirms: [{ id: 'synthetic', label: 'Synthetic suggestion' }], confirmError: null };
    window.agendaProof = { view, props, counts };
    view.render({ ...props, buttonHidden: true, review: null, confirms: [] });
  }, assetUrl);
  assert.equal(await page.locator('#panel').isHidden(), true);
  const selectors = ['[data-open-deal]', '[data-agenda-step]'];
  let assertions = 1;
  for (const cause of ['pending', 'access']) {
    await page.evaluate(() => {
      const { view, props } = window.agendaProof;
      view.render(props);
      document.querySelector('#agendaTitle').focus();
      view.render({ ...props, disabled: true });
    });
    for (const selector of selectors) {
      const control = page.locator(selector);
      assert.equal(await control.isDisabled(), true, cause);
      const box = await control.boundingBox();
      assert.ok(box);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await control.evaluate(node => node.focus());
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      assertions += 2;
    }
    await page.locator('#agendaTitle').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.matches('[data-open-deal],[data-agenda-step]')), false);
    assert.deepEqual(await page.evaluate(() => window.agendaProof.counts), { open: cause === 'pending' ? 0 : 3, step: cause === 'pending' ? 0 : 3 });
    assert.equal(await page.locator('#agendaProgress').textContent(), '2 of 3');
    assert.equal(await page.locator('#panel').isVisible(), true);
    assert.equal(await page.locator('[data-confirm=yes]').isDisabled(), true);
    await page.locator('#agendaTitle').focus();
    await page.evaluate(() => window.agendaProof.view.render(window.agendaProof.props));
    assert.equal(await page.locator('#agendaTitle').evaluate(node => node === document.activeElement), true);
    assertions += 6;
    for (const [index, selector] of selectors.entries()) {
      const control = page.locator(selector), key = index ? 'step' : 'open';
      assert.equal(await control.isEnabled(), true);
      for (const mode of ['pointer', 'Enter', 'Space']) {
        const before = await page.evaluate(key => window.agendaProof.counts[key], key);
        if (mode === 'pointer') await control.click();
        else { await control.focus(); await page.keyboard.press(mode); }
        assert.equal(await page.evaluate(key => window.agendaProof.counts[key], key), before + 1);
        assertions++;
      }
      assertions++;
    }
  }
  await page.evaluate(() => {
    const { view, props } = window.agendaProof;
    view.render({ ...props, review: null, confirms: [], confirmError: 'unavailable' });
  });
  assert.equal(await page.locator('#panel').isHidden(), true);
  assert.equal(await page.locator('[data-confirms-retry]').isVisible(), true);
  await page.evaluate(() => window.agendaProof.view.dispose());
  assert.equal(await page.locator('#panel').textContent(), '');
  assert.equal(await page.locator('#dock').textContent(), '');
  return { assertions: assertions + 4, activations: await page.evaluate(() => window.agendaProof.counts) };
}

class ProtectedAsset extends Error {}

export async function prove({ origin, timeoutMs }) {
  const base = new URL(origin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw Error('Expected a plain HTTP origin');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw Error('Invalid timeout');
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    if (Date.now() >= deadline) throw Error('Overall deadline exceeded');
    return deadline - Date.now();
  };
  const controller = new AbortController();
  const assets = new Map();
  let requests = 0, browserLaunch, expired, routeFailure;
  const read = async (url, maxBytes = 5 * 1024 * 1024) => {
    if (++requests > 65) throw Error('Request limit exceeded');
    const response = await proofFetch(url, { redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(10000, remaining()))]) });
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) throw new ProtectedAsset('Protected release or asset');
    if (!response.ok) throw Error('HTTP ' + response.status);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw Error('Asset byte limit exceeded');
      chunks.push(chunk);
    }
    return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '' };
  };
  const work = async () => {
    const release = await readAppRelease(base, url => read(url, 65536)).catch(error => {
      if (error.exitCode === 78) throw new ProtectedAsset(error.message);
      throw error;
    });
    browserLaunch = launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() }, { signal: controller.signal });
    const browser = await browserLaunch;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    context.setDefaultTimeout(remaining());
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      try {
        if (request.method() !== 'GET' || url.origin !== base.origin) throw Error('Network request denied');
        if (url.pathname === '/__agenda_proof__') return await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
        if (!/^\/js\/[A-Za-z0-9_.-]+\.js$/.test(url.pathname) || url.search) throw Error('Non-module request denied');
        let asset = assets.get(url.href);
        if (!asset) {
          asset = await read(url);
          if (!/(javascript|ecmascript)/.test(asset.type)) throw new ProtectedAsset('Protected JavaScript asset');
          assets.set(url.href, asset);
        }
        await route.fulfill({ contentType: 'text/javascript', body: asset.body });
      } catch (error) { routeFailure ||= error; await route.abort().catch(() => {}); }
    });
    const page = await context.newPage();
    await page.goto(new URL('/__agenda_proof__', base).href);
    let observation;
    try { observation = await exerciseAgenda(page, new URL('/js/ui-agenda.generated.js', base).href); }
    catch (error) { throw routeFailure || error; }
    if (routeFailure) throw routeFailure;
    return { ok: true, origin: base.origin, release, assets: [...assets].map(([url, value]) => ({ url, sha256: createHash('sha256').update(value.body).digest('hex') })), ...observation, limitation: 'Deployed synthetic resilience only. Natural private-data coverage unproven.' };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { expired = setTimeout(() => { controller.abort(Error('Overall deadline exceeded')); reject(controller.signal.reason); }, timeoutMs); })]);
  } finally {
    clearTimeout(expired);
    controller.abort();
    const browser = await browserLaunch?.catch(() => null);
    await browser?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--timeout-ms') throw Error('Usage: --origin <origin> --timeout-ms <milliseconds>');
    const receipt = await prove({ origin: args[1], timeoutMs: Number(args[3]) });
    process.stdout.write(JSON.stringify(receipt) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    process.exitCode = error.exitCode || (error instanceof ProtectedAsset ? 78 : 1);
  }
}
