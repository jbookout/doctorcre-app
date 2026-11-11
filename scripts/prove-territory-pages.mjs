import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { chromium } from './proof-browser.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { chromium as cdpChromium } from 'playwright';
import { launchProofBrowser, readAppRelease, prepareProofFixtureAssets, startProofFixtureAssets } from './app-release-reader.mjs';
import { workspace, detail } from '../test/leads-workspace-fixture.mjs';
import { territoryFixture } from '../test/fixtures/territory-pages/fixture.mjs';

const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
export async function prove({ origin = 'http://localhost', expectedCommit, fixture = false, timeoutMs = 30000,
  cdpUrl, engine = chromium, readRelease = readAppRelease, ancestry, recordingUrl } = {}) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || '') || /^0+$/.test(expectedCommit)) throw unavailable('Expected merge commit required');
  const base = new URL(origin);
  if (fixture && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw unavailable('Fixture mode requires a loopback origin');
  assert.ok(base.href === `${base.origin}/` && !base.username && !base.password && ['https:', 'http:'].includes(base.protocol), 'origin only');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, 'bounded deadline');
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const preparedAssets = fixture ? await prepareProofFixtureAssets(sourceRoot) : undefined;
  const controller = new AbortController(), deadline = Date.now() + timeoutMs;
  let expire;
  const expired = new Promise((_, reject) => { expire = () => { const error = unavailable('Proof deadline exceeded'); controller.abort(error); reject(error); }; });
  void expired.catch(() => {});
  const timer = setTimeout(expire, timeoutMs);
  const bounded = promise => Promise.race([promise, expired]);
  const remaining = () => Math.max(1, deadline - Date.now());
  let browser, page, pendingBrowser, pendingLaunch, fixtureAssets;
  const pendingPages = [];
  const release = async () => bounded(readRelease(base, { timeoutMs: remaining() }));
  async function contains(source) {
    if (!/^[a-f0-9]{40}$/.test(source || '') || /^0+$/.test(source)) throw unavailable('Unknown release');
    if (source === expectedCommit) return;
    try {
      if (ancestry) { if (!await bounded(ancestry(expectedCommit, source))) throw unavailable('Release does not contain expected merge'); }
      else await bounded(new Promise((resolveResult, reject) => {
        execFile('git', ['merge-base', '--is-ancestor', expectedCommit, source], { signal: controller.signal, timeout: remaining() }, error => error ? reject(error) : resolveResult());
      }));
    } catch { throw unavailable('Release ancestry evidence unavailable or release does not contain expected merge'); }
  }
  try {
    const before = await release(); await contains(before.source_commit);
    if (!fixture && !cdpUrl) throw unavailable('Existing signed-in browser session required');
    const recording = fixture ? (recordingUrl ? JSON.parse(await readFile(recordingUrl)) : territoryFixture()) : null;
    try {
      if (fixture) {
        pendingLaunch = engine.launch({ args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() });
        browser = await launchProofBrowser({ launch: () => pendingLaunch }, { timeout: remaining() }, { signal: controller.signal });
      }
      else {
        pendingBrowser = Promise.resolve().then(() => (engine.connectOverCDP ? engine : cdpChromium).connectOverCDP(cdpUrl, { timeout: remaining() })).then(async acquired => {
          if (controller.signal.aborted) { await acquired.close(); throw controller.signal.reason; }
          return acquired;
        });
        browser = await bounded(pendingBrowser);
      }
      if (!fixture && !browser.contexts()[0]) throw unavailable('Signed-in context unavailable');
      const acquisition = (fixture ? browser.newPage({ viewport: { width: 390, height: 844 } }) : browser.contexts()[0].newPage()).then(async acquired => {
        if (controller.signal.aborted) { await acquired.close(); throw controller.signal.reason; }
        return acquired;
      });
      pendingPages.push(acquisition);
      page = await bounded(acquisition);
    } catch (error) { throw unavailable(`Browser session unavailable: ${error.message}`); }
    if (fixture) {
      fixtureAssets = await bounded(startProofFixtureAssets(preparedAssets, controller.signal));
      await bounded(page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== fixtureAssets.origin) return route.abort();
        if (url.pathname === '/mcp') {
          const params = request.postDataJSON()?.params;
          let value;
          if (params?.name === 'territory-state-board') value = recording;
          else if (params?.name === 'lead-board') { value = workspace(); if (params.arguments?.lead_id) value.detail = detail(value.leads.find(row => row.id === params.arguments.lead_id)); }
          else return route.fulfill({ json: { result: { isError: true, content: [{ type: 'text', text: '{"error":"fixture_read_unavailable"}' }] } } });
          return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
        }
        if (request.method() !== 'GET') return route.abort();
        if (url.pathname.startsWith('/api/') || url.pathname === '/auth/session') return route.fulfill({ json: { actor: { slug: 'example-partner' }, csrf_token: 'synthetic-test-token', items: [], counts: {} } });
        return route.continue();
      }));
    }
    let rpc = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/mcp') rpc++; });
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/mcp' && response.request().postDataJSON()?.params?.name === 'territory-state-board', { timeout: remaining() });
    void response.catch(() => {});
    await bounded(page.goto(new URL('/leads', fixtureAssets?.origin || base).href, { timeout: remaining() }));
    const section = page.getByRole('region', { name: 'Recorded territory conditions', exact: true });
    try { await bounded(section.locator('summary').first().click({ timeout: remaining() })); }
    catch { throw unavailable('Signed-in territory panel unavailable'); }
    const observed = await bounded(response).catch(() => { throw unavailable('Territory response unavailable or signed-in session missing'); });
    if ([401, 403].includes(observed.status())) throw unavailable('Signed-in session unavailable');
    const envelope = await bounded(observed.json());
    if (envelope.result?.isError || envelope.error) throw unavailable('Territory snapshot refused');
    let snapshot;
    try { snapshot = JSON.parse(envelope.result.content.find(item => item.type === 'text').text); }
    catch { throw unavailable('Territory snapshot unavailable'); }
    assert.equal(snapshot.schema_version, 'territory-state-board.v1');
    assert.equal(snapshot.coverage, 'recorded_geographies_only');
    assert.ok(Array.isArray(snapshot.submarkets) && snapshot.submarkets.length <= 1000);
    const rows = snapshot.submarkets;
    if (rows.length <= 20) throw unavailable('At least 21 natural areas required to observe pagination');
    const labels = {soft:'Soft',balanced:'Balanced',tight:'Tight',unknown:'Unknown',conflicting:'Conflicting'};
    const assertions = [];
    async function checkPage(matching, offset) {
      const expected = matching.slice(offset, offset + 20).map(row => ({ area: `${row.city}, ${row.state}`, condition: labels[row.condition] }));
      assert.deepEqual(await bounded(section.locator('tbody tr').evaluateAll(nodes => nodes.map(node => ({ area: node.cells[0].textContent, condition: node.cells[1].textContent })))), expected);
      assert.equal(await bounded(section.getByRole('status').first().textContent()), `Showing ${matching.length ? offset + 1 : 0}–${Math.min(offset + 20, matching.length)} of ${matching.length} matching loaded areas / ${rows.length} total loaded areas`);
      assertions.push({ offset, matching: matching.length, exact: expected });
    }
    await bounded(section.locator('tbody tr').first().waitFor({timeout:remaining()}));
    await bounded(page.waitForLoadState('networkidle', { timeout: remaining() }));
    const beforeLocal = rpc;
    for (let offset = 0; offset < rows.length; offset += 20) {
      assert.ok(offset / 20 < 50);
      await checkPage(rows, offset);
      if (offset + 20 < rows.length) await bounded(section.getByRole('button', {name:'Next areas',exact:true}).click());
    }
    await bounded(section.locator('select').first().selectOption(rows[0].condition));
    const matching = rows.filter(row => row.condition === rows[0].condition);
    await checkPage(matching, 0);
    if (matching.length <= 20) throw unavailable('At least 21 areas of one condition required to observe evidence retention');
    await bounded(section.getByRole('button',{name:'Next areas',exact:true}).click());
    await bounded(section.getByLabel('Evidence view',{exact:true}).selectOption('historical'));
    await checkPage(matching,20);
    assert.equal(rpc,beforeLocal,'local page and filter controls issue no business reads');
    const after = await release(); await contains(after.source_commit);
    if (JSON.stringify(after) !== JSON.stringify(before)) throw unavailable('Release changed during observation');
    return {mode:fixture?'local-fixture':'natural',release:before,counts:{loaded:rows.length,matching:matching.length},assertions,business_reads:rpc,local_reads:rpc-beforeLocal};
  } catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
  finally {
    clearTimeout(timer);
    controller.abort(unavailable('Proof retired'));
    await page?.close().catch(() => {});
    await Promise.allSettled(pendingPages.map(pending => pending.then(acquired => acquired.close())));
    await browser?.close().catch(() => {});
    await fixtureAssets?.close();
    if (pendingLaunch) await pendingLaunch.then(acquired => acquired.close()).catch(() => {});
    if (!browser && pendingBrowser) await pendingBrowser.then(acquired => acquired.close()).catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      origin: { type: 'string' }, 'expected-commit': { type: 'string' }, 'cdp-url': { type: 'string' },
      'timeout-ms': { type: 'string' }, recording: { type: 'string' }, fixture: { type: 'boolean', default: false },
    } });
    const result = await prove({ origin: values.origin, expectedCommit: values['expected-commit'], fixture: values.fixture, cdpUrl: values['cdp-url'], timeoutMs: Number(values['timeout-ms'] || 30000), recordingUrl: values.recording });
    console.log(JSON.stringify(result));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message, status: error.exitCode === 78 ? 'insufficient_evidence' : 'assertion_failure' })); process.exitCode = error.exitCode || 1; }
}
