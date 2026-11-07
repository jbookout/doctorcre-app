import { proofArgs } from './proof-browser.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { chromium } from './proof-browser.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';

const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });
export async function prove({ origin, fixture = false, timeoutMs = 30000, engine = chromium, recordingUrl = new URL('../test/fixtures/lead-research-source-dates/recordings.json', import.meta.url) } = {}) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, 'bounded timeout');
  const base = new URL(origin || 'http://localhost');
  assert.ok(['http:', 'https:'].includes(base.protocol) && base.href === `${base.origin}/` && !base.username && !base.password, 'origin only');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(unavailable('Proof deadline exceeded')), timeoutMs);
  let browser;
  let requests = 0, bytes = 0;
  const assets = new Map();
  const read = async url => {
    assert.ok(++requests <= 96, 'asset request cap');
    const response = await proofFetch(url, { signal: abort.signal, redirect: 'manual' });
    if (!response.ok || !/javascript/.test(response.headers.get('content-type') || '')) throw unavailable('Deployed module unavailable');
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert.ok(bytes <= 16 * 1024 * 1024, 'asset byte cap');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  try {
    const recording = JSON.parse(await readFile(recordingUrl));
    const before = fixture ? null : await readAppRelease(base, { timeoutMs });
    browser = await launchProofBrowser(engine, { args: [...CHROMIUM_SAFETY_ARGS], headless: true, timeout: timeoutMs }, { signal: abort.signal });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
    let transportFailure;
    const root = fileURLToPath(new URL('../', import.meta.url));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== 'http://localhost') return route.abort();
      if (url.pathname === '/mcp' && request.method() === 'POST') {
        const params = request.postDataJSON()?.params;
        let payload;
        if (params?.name === 'lead-board') payload = recording;
        else if (params?.name === 'quiet-follow-ups') payload = { schema_version: 'quiet-follow-ups.v1', cadence: { lead_days: 45, vendor_days: 90 }, proposals: [], sent: false, tasks_created: false };
        else if (params?.name === 'list-practice-origination') payload = { contract: 'practice-origination.v1', cards: [], coverage: [], next_cursor: null, outreach_started: false };
        else return route.fulfill({ json: { result: { isError: true, content: [{ type: 'text', text: '{"error":"fixture_read_unavailable"}' }] } } });
        return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
      }
      if (request.method() !== 'GET') return route.abort();
      if (url.pathname.startsWith('/api/') || url.pathname === '/auth/session') return route.fulfill({ json: { actor: { slug: 'example-partner' }, csrf_token: 'synthetic-test-token', items: [], counts: {} } });
      try {
        const path = url.pathname === '/leads' ? '/leads.html' : decodeURIComponent(url.pathname);
        const resolved = resolve(root, `.${path}`);
        if (!resolved.startsWith(root.endsWith(sep) ? root : root + sep)) return route.abort();
        const isModule = /\.m?js$/.test(path);
        let body;
        if (!fixture && path.startsWith('/js/') && isModule) {
          if (!assets.has(path)) assets.set(path, await read(new URL(path, base)));
          body = assets.get(path);
        } else body = await readFile(resolved);
        const type = isModule ? 'text/javascript' : path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'application/json';
        return route.fulfill({ contentType: type, body });
      } catch (error) { transportFailure = error; return route.abort(); }
    });
    await page.goto('http://localhost/leads');
    await page.evaluate(async recording => {
      const { validateLeadWorkspace, validateLeadDetail } = await import('/js/leads-client.js');
      validateLeadWorkspace(recording);
      validateLeadDetail(recording.detail, recording.detail.id);
    }, recording);
    await page.locator('[data-open]').first().click();
    await page.locator('#sourcedResearch').waitFor();
    const observation = await page.locator('#sourcedResearch').innerText();
    if (transportFailure) throw transportFailure;
    assert.match(await page.locator('#sourcedResearch li').first().innerText(), /Observed.*Nov 5, 2026.*7:00.*PM.*CST/);
    assert.match(observation, /Expires on.*Feb 29, 2028/);
    assert.match(observation, /Expiry unrecorded/);
    assert.match(observation, /Observed time unavailable/);
    assert.match(observation, /Expiry date unavailable/);
    const after = fixture ? null : await readAppRelease(base, { timeoutMs });
    assert.deepEqual(after, before, 'stable release');
    if (!fixture) throw unavailable('Deployed-module fixture assertions passed; signed-in natural evidence remains unverified');
    return { ok: true, mode: 'local-fixture', assertions: 6, natural: false };
  } catch (error) {
    if (abort.signal.aborted) throw abort.signal.reason;
    throw error;
  } finally { clearTimeout(timer); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = proofArgs();
    assert.ok(args.every((arg, i) => ['--fixture', '--origin', '--timeout-ms', '--recording'].includes(arg) || i > 0 && ['--origin', '--timeout-ms', '--recording'].includes(args[i - 1])), 'usage: --fixture | --origin URL [--timeout-ms N]');
    const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    const result = await prove({ origin: value('--origin'), fixture: args.includes('--fixture'), timeoutMs: Number(value('--timeout-ms') || 30000), recordingUrl: value('--recording') });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, status: error.exitCode === 78 ? 'insufficient_evidence' : 'assertion_failure', error: error.message }));
    process.exitCode = error.exitCode || 1;
  }
}
