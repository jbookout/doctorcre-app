import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { chromium } from './proof-browser.mjs';
import { chromium as cdpChromium } from 'playwright';
import { launchProofBrowser, readAppRelease, startProofFixtureAssets } from './app-release-reader.mjs';
import { workspace, detail } from '../test/leads-workspace-fixture.mjs';

const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
export async function prove({ origin = 'http://localhost', expectedCommit, fixture = false, timeoutMs = 30000,
  cdpUrl, engine = chromium, readRelease = readAppRelease, ancestry, recordingUrl = new URL('../test/fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url) } = {}) {
  if (!expectedCommit) throw unavailable('Expected merge commit required');
  assert.match(expectedCommit || '', /^[a-f0-9]{40}$/);
  assert.ok(!/^0+$/.test(expectedCommit), 'expected merge commit required');
  const base = new URL(origin);
  assert.ok(base.href === `${base.origin}/` && !base.username && !base.password && ['https:', 'http:'].includes(base.protocol), 'origin only');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, 'bounded deadline');
  const controller = new AbortController(), deadline = Date.now() + timeoutMs;
  let expire;
  const expired = new Promise((_, reject) => { expire = () => { const error = unavailable('Proof deadline exceeded'); controller.abort(error); reject(error); }; });
  void expired.catch(() => {});
  const timer = setTimeout(expire, timeoutMs);
  const bounded = promise => Promise.race([promise, expired]);
  const remaining = () => Math.max(1, deadline - Date.now());
  let browser, page, pendingBrowser, fixtureAssets;
  const pendingPages = [];
  const release = async () => fixture && readRelease === readAppRelease ? { source_commit: expectedCommit } : bounded(readRelease(base, { timeoutMs: remaining() }));
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
    const recording = fixture ? JSON.parse(await readFile(recordingUrl)) : null;
    try {
      // Playwright's CDP browser.close disconnects this connection without closing the remote browser.
      if (fixture) browser = await launchProofBrowser(engine, { timeout: remaining() }, { signal: controller.signal });
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
      fixtureAssets = await bounded(startProofFixtureAssets(fileURLToPath(new URL('../', import.meta.url)), controller.signal));
      await bounded(page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== fixtureAssets.origin) return route.abort();
        if (url.pathname === '/mcp') {
          const params = request.postDataJSON()?.params;
          let value;
          if (params?.name === 'quiet-follow-ups') value = recording;
          else if (params?.name === 'lead-board') { value = workspace(); if (params.arguments?.lead_id) value.detail = detail(value.leads.find(row => row.id === params.arguments.lead_id)); }
          else return route.fulfill({ json: { result: { isError: true, content: [{ type: 'text', text: '{"error":"fixture_read_unavailable"}' }] } } });
          return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
        }
        if (request.method() !== 'GET') return route.abort();
        if (url.pathname.startsWith('/api/') || url.pathname === '/auth/session') return route.fulfill({ json: { actor: { slug: 'example-partner' }, csrf_token: 'synthetic-test-token', items: [], counts: {} } });
        return route.continue();
      }));
    }
    const observedVerbs = [];
    let snapshot, rpc = 0, writes = 0;
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() !== 'GET' && request.method() !== 'HEAD') {
        if (url.pathname !== '/mcp') writes++;
        else {
          rpc++;
          const name = request.postDataJSON()?.params?.name;
          observedVerbs.push(name);
        }
      }
    });
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/mcp' && response.request().postDataJSON()?.params?.name === 'quiet-follow-ups', { timeout: remaining() });
    await bounded(page.goto(new URL('/leads', fixtureAssets?.origin || base).href, { timeout: remaining() }));
    const observed = await bounded(response);
    if ([401, 403].includes(observed.status())) throw unavailable('Signed-in session unavailable');
    const envelope = await bounded(observed.json());
    if (envelope.result?.isError || envelope.error) throw unavailable('Quiet snapshot refused');
    try { snapshot = JSON.parse(envelope.result.content.find(item => item.type === 'text').text); } catch { throw unavailable('Quiet snapshot unavailable'); }
    let registry;
    try {
      if (fixture) registry = JSON.parse(await bounded(readFile(new URL('../test/fixtures/walk-verb-registry.json', import.meta.url)))).response;
      else {
        const outcome = await bounded(page.evaluate(async timeoutMs => {
          const { createMcpRequests } = await import('/js/mcp-requests.mjs');
          return createMcpRequests()('list-verbs', { names_only: true }, { timeoutMs });
        }, remaining()));
        if (outcome.kind !== 'payload' || outcome.isError) throw Error('Registry read refused');
        registry = outcome.payload;
      }
      if (registry?.ok !== true || !Array.isArray(registry.verbs) || !registry.verbs.length
        || registry.count !== registry.verbs.length
        || !registry.verbs.every(verb => typeof verb?.name === 'string' && verb.name.length > 0 && typeof verb.write === 'boolean')
        || new Set(registry.verbs.map(verb => verb.name)).size !== registry.verbs.length) throw Error('Invalid registry response');
    } catch (error) { throw unavailable(`Verb registry unavailable: ${error.message}`); }
    const verbWrites = new Map(registry.verbs.map(verb => [verb.name, verb.write]));
    const leads = await bounded(page.evaluate(async snapshot => {
      const { validateQuietFollowUps } = await import('/js/leads-client.js');
      return validateQuietFollowUps(snapshot).proposals.filter(row => row.subject_type === 'lead');
    }, snapshot));
    if (!leads.length) throw unavailable('No natural quiet leads');
    const section = page.locator('#quietFollowUps'), select = section.getByRole('combobox', { name: 'Quiet lead owner' });
    await bounded(select.waitFor({ timeout: remaining() }));
    const owners = [...new Set(leads.flatMap(row => row.owner == null ? [] : [row.owner]))].sort();
    assert.deepEqual(await bounded(select.locator('option').evaluateAll(nodes => nodes.map(node => [node.value, node.textContent]))), [
      ['all', 'All owners'], ...owners.map(owner => [`owner:${owner}`, owner === 'joe' ? 'Joe' : owner === 'dell' ? 'Dell' : `Recorded owner · ${owner}`]),
      ['unrecorded', 'Owner not recorded'],
    ]);
    const date = value => new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });
    async function checkPage(rows, offset) {
      const visible = rows.slice(offset, offset + 10);
      const expected = visible.map(row => ({ id: row.subject_id, name: row.name,
        href: `/leads?lead=${encodeURIComponent(row.ref)}`,
        reason: (row.basis === 'created_at' ? `No contact recorded. Added ${date(row.anchor_on)}.` : `Last contact ${date(row.anchor_on)}.`)
          + ` Follow-up due ${date(row.due_on)}`
          + (row.days_overdue > 0 ? ` · ${row.days_overdue} ${row.days_overdue === 1 ? 'day' : 'days'} overdue` : ''),
      }));
      assert.deepEqual(await bounded(section.locator('a[data-quiet-lead]').evaluateAll(nodes => nodes.map(node => ({
        id: node.dataset.quietLead, name: node.querySelector('span').textContent,
        href: node.getAttribute('href'), reason: node.querySelector('p').textContent,
      })))), expected);
      assert.equal(await bounded(section.getByRole('status').innerText()), `Showing ${offset + 1}–${Math.min(offset + 10, rows.length)} of ${rows.length} matching loaded leads (${leads.length} loaded).`);
      assert.equal(await bounded(section.getByRole('button', { name: 'Previous leads', exact: true }).getAttribute('aria-disabled')), String(offset === 0));
      assert.equal(await bounded(section.getByRole('button', { name: 'Next leads', exact: true }).getAttribute('aria-disabled')), String(offset + 10 >= rows.length));
    }
    const key = leads[0].owner == null ? 'unrecorded' : `owner:${leads[0].owner}`;
    const matching = leads.filter(row => row.owner == null ? key === 'unrecorded' : `owner:${row.owner}` === key);
    await bounded(page.waitForLoadState('networkidle', { timeout: remaining() }));
    const beforeLocal = rpc;
    await bounded(select.selectOption(key));
    for (let offset = 0; offset < matching.length; offset += 10) {
      assert.ok(offset < 1000, 'bounded loaded list');
      await checkPage(matching, offset);
      if (offset + 10 < matching.length) await bounded(section.getByRole('button', { name: 'Next leads', exact: true }).click());
    }
    await bounded(select.selectOption('all'));
    await checkPage(leads, 0);
    assert.equal(rpc, beforeLocal, 'no local selection/page RPC');
    const unknownVerbs = new Set();
    for (const name of observedVerbs) {
      if (!verbWrites.has(name)) unknownVerbs.add(String(name));
      else if (verbWrites.get(name)) writes++;
    }
    assert.equal(unknownVerbs.size, 0, `Unknown MCP verbs: ${[...unknownVerbs].sort().join(', ')}`);
    assert.equal(writes, 0, 'no writes');
    const after = await release(); await contains(after.source_commit); assert.deepEqual(after, before, 'stable release');
    return { ok: true, mode: fixture ? 'local-fixture' : 'natural', release: before, leads: leads.length, matching: matching.length, writes };
  } catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
  finally {
    clearTimeout(timer);
    await page?.close().catch(() => {});
    await Promise.allSettled(pendingPages.map(pending => pending.then(acquired => acquired.close())));
    await browser?.close().catch(() => {});
    await fixtureAssets?.close();
    if (!browser && pendingBrowser) void pendingBrowser.then(acquired => acquired.close()).catch(() => {});
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
