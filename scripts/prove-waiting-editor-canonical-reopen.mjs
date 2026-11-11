import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { chromium } from 'playwright';
import { context as buildContext } from 'esbuild';
import { init, parse } from 'es-module-lexer';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function syntheticWaiting(signal) {
  signal?.throwIfAborted();
  const compiler = await buildContext({ stdin: { contents: "export {fixtureInboxRpc} from './src/ui/home/fixture'; export {createInboxClient,parseSnapshot} from './src/ui/home/inbox';", resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'esm' });
  const cancel = () => { void compiler.cancel(); };
  signal?.addEventListener('abort', cancel, { once: true });
  let compiled;
  try {
    signal?.throwIfAborted();
    compiled = await compiler.rebuild();
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', cancel);
    await compiler.dispose();
  }
  const { fixtureInboxRpc, createInboxClient, parseSnapshot } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
  const raw = fixtureInboxRpc();
  const rpc = async (name, args) => {
    const value = await raw(name, args);
    if (name === 'read-home-inbox-v5') parseSnapshot(value);
    return value;
  };
  const client = createInboxClient(rpc);
  const seed = async reason => {
    const item = (await client.read()).items[0];
    return client.wait({ action: 'set', args: { idempotency_key: crypto.randomUUID(), item_id: item.item_id, item_version: item.base_version, base_version: item.waiting_version, reason, evidence: [`proof:${reason}`], target: { kind: 'party', id: '00000000-0000-0000-0000-000000000099' } } });
  };
  signal?.throwIfAborted();
  await seed('Old reason');
  return { rpc, client, seed, parseSnapshot };
}

export async function observeWaiting(page, synthetic, writes, loseReply) {
  const row = page.locator('[data-inbox-row="demo-review"]');
  const open = () => row.getByRole('button', { name: 'Correct waiting person', exact: true }).click();
  const reason = row.getByLabel('Reason', { exact: true });
  const evidence = row.getByLabel('Evidence references, one per line');
  const check = async (value, refs) => {
    if (await reason.inputValue() !== value || await evidence.inputValue() !== refs) throw Error('Canonical reason/evidence contradiction');
  };
  await row.getByText('Old reason', { exact: true }).waitFor();
  await synthetic.seed('New canonical reason');
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await row.getByText('New canonical reason', { exact: true }).waitFor();
  await open(); await check('New canonical reason', 'proof:New canonical reason');
  const assertions = ['closed-refresh-opens-canonical-snapshot'];
  await reason.fill('Deliberate draft'); await evidence.fill('proof:local');
  await synthetic.seed('Background reason');
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await row.getByText('Background reason', { exact: true }).waitFor();
  await check('Deliberate draft', 'proof:local');
  assertions.push('background-refresh-preserves-dirty-draft');
  await row.getByRole('button', { name: 'Close editor' }).click(); await open();
  await check('Background reason', 'proof:Background reason');
  assertions.push('close-reopen-discards-draft');
  await row.getByRole('button', { name: 'Load people', exact: true }).click();
  await row.getByLabel('Search people by name').fill('Demo');
  await row.getByLabel('Person', { exact: true }).selectOption('00000000-0000-0000-0000-000000000099');
  loseReply();
  await row.getByRole('button', { name: 'Save waiting person' }).click();
  await row.getByRole('button', { name: 'Retry same waiting request' }).waitFor();
  if (!await reason.isDisabled() || !await row.getByRole('button', { name: 'Close editor' }).isDisabled()) throw Error('Uncertain write permits opposing edits');
  await row.getByRole('button', { name: 'Retry same waiting request' }).click();
  await open(); await check('Background reason', 'proof:Background reason');
  if (writes.length !== 2 || JSON.stringify(writes[0]) !== JSON.stringify(writes[1])) throw Error('Recovery changed original request');
  assertions.push('lost-reply-replays-identical-request', 'confirmed-save-reopens-canonical-readback');
  return assertions;
}

export async function prove({ origin, timeoutMs = 30000 }) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw Error('Expected bare http(s) origin');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('timeout-ms must be 1..30000');
  let browser, timer, bytes = 0;
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const assets = new Map();
  const allowed = new Set(['/js/ui-inbox.generated.js', '/js/boot-mode.js', '/js/private-session.js', '/js/mcp-requests.mjs']);
  const receipt = { release: null, assets: [], assertions: [], synthetic: true };
  const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
  const fetchBytes = async path => {
    let response;
    try { response = await proofFetch(url.origin + path, { signal: controller.signal, redirect: 'error' }); }
    catch { throw unavailable(`Unavailable asset ${path}`); }
    if (!response.ok) throw unavailable(`Unavailable asset ${path}: ${response.status}`);
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 10 * 1024 * 1024) throw unavailable('Asset byte budget exceeded');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const asset = async path => {
    if (assets.has(path)) return assets.get(path);
    if (!allowed.has(path) || !/^\/js\/[a-zA-Z0-9_.-]+\.m?js$/.test(path) || assets.size >= 30) throw unavailable(`Asset outside allowlist or budget: ${path}`);
    const pending = (async () => {
      const body = await fetchBytes(path);
      const [imports] = parse(body.toString());
      for (const entry of imports) if (entry.n?.startsWith('.')) {
        const dependency = new URL(entry.n, url.origin + path);
        if (dependency.origin === url.origin) allowed.add(dependency.pathname);
      }
      receipt.assets.push({ path, sha256: createHash('sha256').update(body).digest('hex') });
      return body;
    })();
    assets.set(path, pending);
    return pending;
  };
  const worker = (async () => {
    try {
      await init;
      receipt.release = await readAppRelease(url, async url => ({ type: 'application/json', body: await fetchBytes(url.pathname) }));
      controller.signal.throwIfAborted();
      const synthetic = await syntheticWaiting(controller.signal);
      controller.signal.throwIfAborted();
      const writes = []; let lost = false; let assetFailure; let rpcCount = 0;
      browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: Math.max(1, Math.ceil(deadline - performance.now())) }, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const context = await browser.newContext({ serviceWorkers: 'block' });
      context.setDefaultTimeout(Math.min(5000, Math.floor(timeoutMs / 2)));
      await context.route('**/*', async route => {
        const request = route.request(), target = new URL(request.url());
        if (target.origin !== url.origin) return route.abort();
        if (target.pathname === '/mcp' && request.method() === 'POST') {
          if (++rpcCount > 64) return route.abort();
          const { name, arguments: args } = request.postDataJSON().params;
          if (!['read-home-inbox-v5', 'set-home-waiting', 'read-actor-roster-v1', 'search-parties-v1', 'email-match-contacts'].includes(name)) return route.abort();
          const write = name === 'set-home-waiting';
          if (write) writes.push({ name, args });
          try {
            const value = await synthetic.rpc(name, args);
            if (write && lost) { lost = false; return route.abort(); }
            return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
          } catch { return route.abort(); }
        }
        if (request.method() !== 'GET') return route.abort();
        if (target.pathname === '/inbox') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="homeRoot" data-inbox></main><script type="module" src="/js/ui-inbox.generated.js"></script>' });
        if (target.pathname === '/auth/session') return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-proof' } });
        try { return await route.fulfill({ contentType: 'text/javascript', body: await asset(target.pathname) }); }
        catch (error) { assetFailure = error; return route.abort(); }
      });
      controller.signal.throwIfAborted();
      const page = await context.newPage();
      controller.signal.throwIfAborted();
      await page.goto(url.origin + '/inbox?mode=live');
      try { receipt.assertions = await observeWaiting(page, synthetic, writes, () => { lost = true; }); }
      catch (error) { throw assetFailure || error; }
      if (!receipt.assets.some(entry => entry.path === '/js/ui-inbox.generated.js')) throw unavailable('Inbox entry unavailable');
      receipt.fetched_bytes = bytes;
      if (Buffer.byteLength(JSON.stringify(receipt)) > 65536) throw Error('Receipt budget exceeded');
      return receipt;
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally { await browser?.close(); }
  })();
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = unavailable('Proof deadline exceeded');
      controller.abort(error);
      void browser?.close().catch(() => {});
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([expired, worker]); }
  finally {
    controller.abort();
    await worker.catch(() => {});
    clearTimeout(timer);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, help: { type: 'boolean' } } });
    if (values.help) console.log('node scripts/prove-waiting-editor-canonical-reopen.mjs --origin https://app.doctorcre.com --timeout-ms 30000');
    else console.log(JSON.stringify(await prove({ origin: values.origin, timeoutMs: Number(values['timeout-ms']) })));
  } catch (error) { console.error(error.message); process.exitCode = error.exitCode || 1; }
}
