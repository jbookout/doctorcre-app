import assert from 'node:assert/strict';

const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
export async function guardProofReads(page, origin) {
  let registry, failure, settle, loaded = false;
  const ready = new Promise(resolve => { settle = resolve; });
  const observed = [];
  function check(name) {
    if (!registry?.has(name)) failure ||= unavailable(`Unknown MCP verb: ${String(name)}`);
    else if (registry.get(name)) failure = Object.assign(new assert.AssertionError({ message: `no writes: ${name}` }), { exitCode: 1 });
    return registry?.get(name) === false;
  }
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (['GET', 'HEAD'].includes(request.method())) return route.fallback();
    let body;
    try { body = request.postDataJSON(); } catch {}
    if (url.pathname !== '/mcp' || request.method() !== 'POST' || body?.method !== 'tools/call') {
      failure = Object.assign(new assert.AssertionError({ message: 'no writes: non-MCP request' }), { exitCode: 1 });
      return route.abort();
    }
    const name = body.params?.name;
    observed.push(name);
    if (name === 'list-verbs' && !registry) return route.fallback();
    await ready;
    return check(name) ? route.fallback() : route.abort();
  });
  return {
    async load(timeoutMs) {
      if (loaded) throw Error('Registry already loaded');
      loaded = true;
      try {
        const outcome = await page.evaluate(async timeoutMs => {
          const { createMcpRequests } = await import('/js/mcp-requests.mjs');
          return createMcpRequests()('list-verbs', { names_only: true }, { timeoutMs });
        }, timeoutMs);
        if (outcome?.kind !== 'payload' || outcome.isError) throw Error('Registry refused');
        const value = outcome.payload;
        if (value?.ok !== true || !Array.isArray(value.verbs) || !value.verbs.length || value.count !== value.verbs.length
          || !value.verbs.every(row => typeof row?.name === 'string' && row.name.trim().length > 0 && typeof row.write === 'boolean')
          || new Set(value.verbs.map(row => row.name)).size !== value.verbs.length) throw Error('Invalid registry');
        registry = new Map(value.verbs.map(row => [row.name, row.write]));
        for (const name of observed) check(name);
      } catch (error) { failure ||= unavailable(`Verb registry unavailable: ${error.message}`); }
      finally { settle(); }
      this.assertSafe();
    },
    assertSafe() { if (failure) throw failure; },
    get writes() { return observed.filter(name => registry?.get(name) === true).length; },
    dispose() { settle(); },
  };
}
