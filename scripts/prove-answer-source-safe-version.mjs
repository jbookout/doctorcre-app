import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { init, parse } from 'es-module-lexer';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function assertAnswerSourceVersions() {
  const api = await import('/js/ui-answers.generated.js');
  const results = [];
  const check = (name, ok) => {
    results.push({ name, passed: Boolean(ok) });
    if (!ok) throw new Error(name);
  };
  check('mount interface', typeof api.mountAnswerBlocks === 'function' && typeof api.disposeAnswerBlocks === 'function');
  const fact_id = '11111111-1111-4111-8111-111111111111';
  const blocks = source => [{type:'table.v1',id:'safe',columns:[{key:'amount',label:'Amount',type:'number'}],rows:[{amount:{value:24,source}}]}];
  const prose = document.createElement('p');
  prose.textContent = 'Plain answer remains usable.';
  const host = document.createElement('div');
  document.body.append(prose, host);
  const render = async (input, identity) => {
    api.mountAnswerBlocks(host, input, identity);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  try {
    for (const version of [1, Number.MAX_SAFE_INTEGER]) {
      await render(blocks({fact_id,version}), `valid-${version}`);
      check(`safe version ${version}`, host.querySelector('.answer-source')?.textContent.includes(`version ${version}`));
    }
    await render(blocks({record_id:fact_id}), 'record');
    check('record source preserved', host.querySelector('.answer-source')?.textContent.includes(`Record ${fact_id}`));
    for (const version of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,Number.MAX_VALUE,NaN,Infinity,-Infinity]) {
      await render(blocks({fact_id,version}), `invalid-${version}`);
      check(`refuse ${version}`, host.textContent === 'Interactive answer unavailable' && !host.querySelector('table, .answer-source'));
      check(`plain text survives ${version}`, prose.textContent === 'Plain answer remains usable.');
    }
    const inputs = ['9007199254740992','9007199254740993'].map(literal => JSON.parse(JSON.stringify(blocks({fact_id,version:1})).replace('"version":1',`"version":${literal}`)));
    check('unsafe JSON versions collide', inputs[0][0].rows[0].amount.source.version === inputs[1][0].rows[0].amount.source.version);
    for (const [index, input] of inputs.entries()) {
      await render(input, `json-${index}`);
      check(`refuse unsafe JSON ${index}`, host.textContent === 'Interactive answer unavailable');
    }
    for (const input of [undefined, []]) {
      await render(input, 'plain');
      check('plain answer needs no interactive blocks', host.textContent === '' && prose.isConnected);
    }
    await render(blocks({fact_id,version:1}), 'teardown');
    api.disposeAnswerBlocks(host);
    api.disposeAnswerBlocks(host);
    check('teardown clears mounted answer', host.childNodes.length === 0);
    return results;
  } finally {
    api.disposeAnswerBlocks(host);
    host.remove();
    prose.remove();
  }
}

export async function prove({ origin, timeoutMs }) {
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
      browser = await launchProofBrowser(chromium, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: Math.max(1, timeoutMs - (Date.now() - started)) }, { signal: controller.signal });
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
      receipt.assertions = await page.evaluate(assertAnswerSourceVersions);
    })()]);
    return { ...receipt, status: 'passed', exitCode: 0 };
  } catch (error) {
    if (!error.unavailable) receipt.assertions.push({name:error.message,passed:false});
    return { ...receipt, status: error.unavailable ? 'unavailable' : 'failed', error: error.message, exitCode: error.unavailable ? 78 : 1 };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await browser?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: {type:'string'}, 'timeout-ms': {type:'string'} } });
    const url = new URL(values.origin);
    const timeoutMs = Number(values['timeout-ms']);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.href !== `${url.origin}/` || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Use --origin <origin> --timeout-ms <1..30000>');
    const result = await prove({origin:url.origin,timeoutMs});
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.log(JSON.stringify({status:'failed',error:error.message,exitCode:1}));
    process.exitCode = error.exitCode || 1;
  }
}
