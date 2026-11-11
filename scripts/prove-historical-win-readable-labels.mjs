import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function recordings() {
  const data = JSON.parse(await readFile(new URL('../test/fixtures/historical-win-readable-labels/recordings.json', import.meta.url)));
  const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/mcp_read_contracts/ideal-client-profile.json', import.meta.url)));
  for (const payload of Object.values(data)) {
    assert.equal(payload.schema_version, contract.schema_version);
    assert.equal(payload.coverage, contract.coverage);
    assert.ok(Array.isArray(payload.profiles));
    for (const row of payload.profiles) {
      assert.ok(row.clients > 0 && row.clients <= row.won_deals);
      assert.equal(row.evidence.length, row.won_deals);
      assert.equal(row.hypothesis, contract.profiles.hypothesis);
    }
  }
  return data;
}

export async function labelAssertions(page, moduleURL) {
  const data = await recordings();
  await page.evaluate(async ({ moduleURL, payload }) => {
    const { mountIdealClientProfile } = await import(moduleURL);
    const { createLeadBoardClient } = await import(new URL('./leads-client.js', moduleURL).href);
    const host = document.createElement('main'); document.body.append(host);
    const p = window.labelsProof = { payload, pending: [] };
    const client = createLeadBoardClient({ docContext: false, fetchImpl: async (_path, init) => {
      const request = JSON.parse(init.body);
      const response = () => Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(p.payload) }] } });
      return p.hold ? new Promise(resolve => p.pending.push(() => resolve(response()))) : response();
    } });
    p.mount = mountIdealClientProfile(host, client);
  }, { moduleURL, payload: data.named });
  const region = page.getByRole('region', { name: 'Historical client fit', exact: true });
  await region.locator('summary').first().click(); await region.getByRole('table').waitFor();
  await region.getByText('Wins (4)', { exact: true }).click();
  const evidence = data.named.profiles[0].evidence;
  assert.deepEqual(await region.getByRole('link').allTextContents(), evidence.map(e => `${e.deal_name.trim() || 'Won deal'} · ${e.closed_on}`), 'recorded names and dates');
  assert.deepEqual(await region.getByRole('link').evaluateAll(links => links.map(a => a.getAttribute('href'))), evidence.map(e => `/deals?deal=${e.deal_id}`), 'source order and UUID navigation');
  assert.equal(await region.locator('img,script').count(), 0, 'hostile names render as text');
  assert.match(await region.innerText(), /Unrecorded/);
  assert.match(await region.innerText(), /Historical fit, not a prediction or qualification rule/);
  const refresh = async payload => {
    await page.evaluate(payload => { window.labelsProof.payload = payload; }, payload);
    await region.getByRole('button', { name: 'Refresh history' }).click();
  };
  await refresh(data.legacy); await region.getByRole('table').waitFor();
  await region.getByText('Wins (4)', { exact: true }).click();
  assert.deepEqual(await region.getByRole('link').allTextContents(), evidence.map(e => `Won deal · ${e.closed_on}`), 'old producer fallback');
  const nullable = structuredClone(data.named); nullable.profiles[0].evidence[0].deal_name = null;
  await refresh(nullable); await region.getByRole('table').waitFor();
  await region.getByText('Wins (4)', { exact: true }).click();
  assert.equal(await region.getByRole('link').first().textContent(), `Won deal · ${evidence[0].closed_on}`);
  for (const patch of [{ closed_on: '2026-02-31' }, { deal_name: 12 }]) {
    const invalid = structuredClone(data.named); Object.assign(invalid.profiles[0].evidence[0], patch);
    await refresh(invalid); await region.getByRole('alert').waitFor();
    assert.equal(await region.getByRole('table').count(), 0, 'invalid response is refused by production parser');
  }
  await refresh(data.empty); await region.getByText('No completed wins match these filters. No historical client profile can be inferred.').waitFor();
  await refresh(data.named); await region.getByRole('table').waitFor();
  await page.evaluate(() => { window.labelsProof.hold = true; });
  await region.getByRole('button', { name: 'Refresh history' }).click(); await region.getByRole('status').waitFor();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('doctorcre-session-invalidated'));
    window.labelsProof.pending.splice(0).forEach(resolve => resolve());
  });
  assert.equal(await region.locator('a,table,button').count(), 0, 'retirement rejects late evidence');
  await page.evaluate(() => window.labelsProof.mount.dispose());
  assert.equal(await region.count(), 0, 'dispose removes evidence');
  return ['named and blank evidence', 'UUID order and duplicate names', 'hostile text', 'legacy and null fallback', 'invalid response refusal', 'empty history', 'retirement and disposal'];
}

export function options(args) {
  const { values } = parseArgs({ args, options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, fixture: { type: 'boolean', default: false } } });
  const url = new URL(values.origin);
  assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)));
  assert.equal(url.href, `${url.origin}/`);
  const timeout = Number(values['timeout-ms']);
  assert.ok(Number.isInteger(timeout) && timeout >= 100 && timeout <= 300000);
  assert.ok(!values.fixture || ['localhost','127.0.0.1','[::1]'].includes(url.hostname), 'fixture success is local only');
  return { origin: url.origin, timeout, fixture: values.fixture };
}

export async function prove({ origin, timeout = 30000, fixture = false }) {
  const signal = AbortSignal.timeout(timeout);
  const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
  let browser, transportFailure, requests = 0, bytes = 0;
  const assets = new Map();
  async function read(url) {
    assert.ok(++requests <= 40, 'request cap');
    const response = await proofFetch(url, { signal });
    if (!response.ok) throw unavailable(`asset unavailable ${response.status}`);
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length; assert.ok(bytes <= 16 * 1024 * 1024, 'byte cap'); chunks.push(chunk);
    }
    return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '' };
  }
  try {
    const before = await readAppRelease(origin, read);
    browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout }, { signal });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') return route.abort();
      if (url.pathname === '/__labels__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Recorded win labels</title>' });
      if (!url.pathname.startsWith('/js/') || !(/\.m?js$/).test(url.pathname)) return route.abort();
      try {
        const asset = assets.get(url.href) || await read(url);
        if (!asset.type.includes('javascript')) throw unavailable('module unavailable');
        assets.set(url.href, asset); return route.fulfill({ contentType: asset.type, body: asset.body });
      } catch (error) { transportFailure = error; return route.abort(); }
    });
    const page = await context.newPage(); page.setDefaultTimeout(timeout);
    await page.goto(`${origin}/__labels__`);
    const assertions = await labelAssertions(page, `${origin}/js/ui-ideal-client-profile.generated.js`);
    const after = await readAppRelease(origin, read);
    assert.equal(before.source_commit, after.source_commit, 'stable app identity');
    const receipt = { status: fixture ? 'fixture_pass' : 'insufficient_evidence', app_release: after, assertions,
      assets: [...assets].map(([url, asset]) => ({ url, sha256: createHash('sha256').update(asset.body).digest('hex') })), requests,
      natural_evidence: 'Signed-in producer read and CARR release comparison must be observed separately by the authorized auditor.' };
    return receipt;
  } catch (error) {
    if (signal.aborted) throw unavailable('proof deadline exceeded');
    throw transportFailure || error;
  } finally { await browser?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const receipt = await prove(options(process.argv.slice(2))); console.log(JSON.stringify(receipt));
    if (receipt.status === 'insufficient_evidence') process.exitCode = 78;
  } catch (error) { console.error(JSON.stringify({ status: error.exitCode === 78 ? 'insufficient_evidence' : 'failed', error: error.message })); process.exitCode = error.exitCode || 1; }
}
