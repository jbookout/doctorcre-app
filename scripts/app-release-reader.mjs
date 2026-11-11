export const APP_RELEASE_PATH = '/app-release';

export async function startProofFixtureAssets(sourceRoot, signal) {
  signal.throwIfAborted();
  const { appAssetSnapshot } = await import('./fixture-app-assets.mjs');
  const { startWorkerFixture } = await import('./fixture-http.mjs');
  const assets = await appAssetSnapshot(undefined, sourceRoot);
  signal.throwIfAborted();
  return startWorkerFixture({ assets, signal, env: { APP_ENV: 'fixture', CARR: { fetch: async () => new Response(null, { status: 200 }) } } });
}
const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });

function parseRelease(response) {
  try {
    if (!response.type.includes('json')) throw Error();
    const release = JSON.parse(response.body.toString());
    if (release?.service !== 'doctorcre-app' || release.environment !== 'production'
      || typeof release.source_commit !== 'string' || !/^[a-f0-9]{40}$/.test(release.source_commit)
      || /^0+$/.test(release.source_commit)) throw Error();
    return release;
  } catch { throw unavailable('Missing app release identity'); }
}

async function releaseBody(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 65536) throw unavailable('App release identity exceeds byte budget');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function proofFetch(url, options = {}) {
  if (options.redirect && !['manual', 'error'].includes(options.redirect)) throw unavailable('Proof redirects are refused');
  if (options.method && options.method !== 'GET') throw unavailable('Proof HTTP is read-only');
  const headers = new Headers(options.headers);
  headers.set('x-doctorcre-release-reader', '1');
  let response;
  try { response = await fetch(url, { ...options, headers, redirect: options.redirect === 'manual' ? 'manual' : 'error', signal: options.signal || AbortSignal.timeout(30000) }); }
  catch { throw unavailable('Proof HTTP unavailable'); }
  if (new URL(url).pathname === APP_RELEASE_PATH && !response.ok) throw unavailable(`Proof HTTP unavailable (${response.status})`);
  if (new URL(url).pathname === APP_RELEASE_PATH) {
    const copy = response.clone();
    parseRelease({ type: copy.headers.get('content-type') || '', body: await releaseBody(copy) });
  }
  return response;
}

// Callback transports retain their existing aggregate byte and request budgets.
export async function readAppRelease(origin, read = {}) {
  const url = new URL(APP_RELEASE_PATH, origin);
  let response;
  if (typeof read === 'function') response = await read(url);
  else {
    const result = await proofFetch(url, { signal: AbortSignal.timeout(read.timeoutMs || 30000), cache: 'no-store' });
    response = { type: result.headers.get('content-type') || '', body: await releaseBody(result) };
  }
  return parseRelease(response);
}

// A supplied signal owns the whole proof deadline, including its refusal reason.
// Without one, this helper owns a bounded standalone browser lifetime.
export async function launchProofBrowser(engine, options = {}, { signal } = {}) {
  signal?.throwIfAborted();
  const timeout = options.timeout || 30000;
  let browser, timer, expired = false;
  let failure = unavailable('Proof browser deadline exceeded');
  let onAbort;
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
  const deadline = new Promise((_, reject) => {
    const expire = () => {
      expired = true;
      failure = signal?.reason || failure;
      void browser?.close().catch(() => {});
      reject(failure);
    };
    if (signal) { onAbort = expire; signal.addEventListener('abort', onAbort, { once: true }); }
    else timer = setTimeout(expire, timeout);
  });
  const pending = Promise.resolve().then(() => engine.launch(options)).then(async acquired => {
    if (expired) { await acquired.close(); throw failure; }
    browser = acquired;
    return acquired;
  });
  const proxies = new WeakMap();
  function wrap(target) {
    if (!target || typeof target !== 'object') return target;
    if (proxies.has(target)) return proxies.get(target);
    const proxy = new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key);
      if (typeof value !== 'function') return value;
      if (key === 'close') return async (...args) => { if (object === browser) cleanup(); return value.apply(object, args); };
      return (...args) => {
        if (expired) throw failure;
        const result = value.apply(object, args);
        const ownsHandle = ['newContext', 'newPage', 'locator', 'getByRole', 'getByText', 'getByLabel', 'filter', 'first', 'nth', 'last'].includes(key);
        if (result?.then) return Promise.race([result, deadline]).then(value => ownsHandle ? wrap(value) : value);
        return ownsHandle ? wrap(result) : result;
      };
    } });
    proxies.set(target, proxy);
    return proxy;
  }
  try { return wrap(await Promise.race([pending, deadline])); }
  catch (error) { cleanup(); throw error; }
}
