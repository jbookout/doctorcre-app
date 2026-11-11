import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export function recordings() {
  return JSON.parse(readFileSync(new URL('../test/fixtures/market-terms-recorded-stage-filter/recordings.json', import.meta.url), 'utf8')).records;
}

export async function exerciseStage(page, origin) {
  await page.evaluate(async ({ origin, records }) => {
    const { mountMarketTerms } = await import('/js/ui-market.generated.js');
    window.stageRecords = records;
    window.stageResponse = records.full.response;
    window.stageCalls = [];
    window.stagePanel = mountMarketTerms(document.querySelector('#comparison'), {
      entityRef: 'synthetic-a', dealName: ref => ref,
      client: { readMarketTerms: async args => { window.stageCalls.push(args); return window.stageResponse; } },
    });
  }, { origin, records: recordings() });
  const root = page.locator('#comparison');
  const stage = root.getByLabel('Recorded stage', { exact: true });
  const term = root.getByLabel('Term', { exact: true });
  await stage.waitFor();
  assert.deepEqual(await stage.locator('option').allTextContents(), ['All recorded stages', 'counter', 'executed', 'reviewed future']);
  const identities = () => root.locator('tbody tr').evaluateAll(rows => rows.map(row => row.textContent));
  const all = await identities();
  await term.selectOption('rent');
  const rent = await identities();
  await stage.focus();
  await stage.press('c');
  await stage.press('Enter');
  await stage.selectOption('counter');
  await root.getByText('1 matching loaded term across 1 deal.', { exact: true }).waitFor();
  assert.equal(await stage.evaluate(node => node === document.activeElement), true);
  assert.match(await root.locator('tbody').textContent(), /Quarantined: not supporting evidence/);
  assert.equal(await root.locator('.superseded').count(), 0, 'hidden executed successor cannot supersede a counter');
  await stage.selectOption('executed');
  await root.getByText('3 matching loaded terms across 2 deals.', { exact: true }).waitFor();
  assert.equal(await root.locator('.superseded').count(), 1);
  assert.deepEqual(await identities(), rent.filter(text => !text.includes('counter')));
  await stage.selectOption('');
  assert.deepEqual(await identities(), rent);
  await term.selectOption('TI');
  await stage.selectOption('counter');
  await root.getByText('No comparable terms match these filters.', { exact: true }).waitFor();
  await stage.selectOption('executed');
  await root.getByText('1 matching loaded term across 1 deal.', { exact: true }).waitFor();
  await term.selectOption('');
  await stage.selectOption('reviewed future');
  await root.getByText('1 matching loaded term across 1 deal.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.stageCalls.length), 1, 'local filters never read');
  await root.locator('summary').click();
  const coverage = await root.locator('details').textContent();
  await stage.selectOption('counter');
  assert.equal(await root.locator('details').textContent(), coverage);
  await page.evaluate(() => window.stagePanel.refresh());
  await stage.waitFor();
  assert.equal(await stage.inputValue(), 'counter');
  await page.evaluate(() => { window.stageResponse = window.stageRecords.executed.response; window.stagePanel.refresh(); });
  await root.getByText('The previously selected recorded stage is no longer in the loaded results. Showing all recorded stages.', { exact: true }).waitFor();
  assert.equal(await stage.inputValue(), '');
  assert.match(await root.textContent(), /previously selected recorded stage is no longer in the loaded results/i);
  await page.evaluate(() => { window.stageResponse = window.stageRecords.empty.response; window.stagePanel.refresh(); });
  await root.getByText('0 matching loaded terms across 0 deals.', { exact: true }).waitFor();
  assert.deepEqual(await stage.locator('option').allTextContents(), ['All recorded stages']);
  assert.match(await root.textContent(), /0 matching loaded terms across 0 deals/);
  await page.evaluate(() => window.stagePanel.dispose());
  assert.equal(await root.textContent(), '');
  return { all_rows: all.length, restored_rent_rows: rent.length, reads: 4, local_changes_without_reads: true };
}

export async function observeNaturalStage(page) {
  const root = page.locator('#workspace-market-terms');
  if (!await root.isVisible()) await page.getByRole('tab', { name: 'Compare terms', exact: true }).click();
  const loaded = page.waitForResponse(response => {
    try { const rpc = response.request().postDataJSON(); return new URL(response.url()).pathname === '/mcp' && rpc?.params?.name === 'read-market-terms'; }
    catch { return false; }
  });
  await root.getByRole('button', { name: 'Compare', exact: true }).click();
  const response = await loaded;
  const envelope = await response.json();
  const data = JSON.parse(envelope.result.content.find(item => item.type === 'text').text);
  const stage = root.getByLabel('Recorded stage', { exact: true });
  await stage.waitFor();
  if (!data.rows?.length) throw Object.assign(Error('insufficient_evidence: natural query has no rows'), { exitCode: 78 });
  const term = await root.getByLabel('Term', { exact: true }).inputValue();
  const subset = data.rows.filter(row => !term || row.fact_key === term);
  if (!subset.length) throw Object.assign(Error('insufficient_evidence: current fact-key subset has no rows'), { exitCode: 78 });
  const chosen = subset.find(row => row.term_kind.trim())?.term_kind;
  if (!chosen) throw Object.assign(Error('insufficient_evidence: no recorded stage'), { exitCode: 78 });
  const identities = () => root.locator('tbody tr').evaluateAll(rows => rows.map(row => [
    row.querySelector('a').getAttribute('href'), row.querySelector('[data-label="Date"]').textContent,
    row.querySelector('[data-label="Stage"]').textContent, row.querySelector('[data-label="Term"]').textContent.split(':')[0],
    row.querySelector('[data-label="Effective period"]').textContent,
  ]));
  await stage.selectOption('');
  const baseline = await identities();
  await stage.selectOption(chosen);
  const selected = subset.filter(row => row.term_kind === chosen);
  assert.deepEqual(await identities(), baseline.filter(identity => identity[2] === chosen), 'natural selected row identities');
  const deals = new Set(selected.map(row => row.entity_ref)).size;
  assert.match(await root.textContent(), new RegExp(`${selected.length} matching loaded terms? across ${deals} deals?`));
  await stage.selectOption('');
  assert.deepEqual(await identities(), baseline, 'clear stage restores current fact-key subset');
  return { natural_rows: data.rows.length, selected_rows: selected.length, distinct_deals: deals,
    stage: chosen, stage_diversity: new Set(data.rows.map(row => row.term_kind)).size,
    counts: Object.fromEntries([...new Set(data.rows.map(row => JSON.stringify([row.term_kind, row.fact_key])))].map(key => [key, data.rows.filter(row => JSON.stringify([row.term_kind, row.fact_key]) === key).length])) };
}

export async function prove({ origin, timeoutMs = 30000, fixture = false, engine = chromium }) {
  const url = new URL(origin);
  assert.ok(url.origin === origin && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'origin only');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'bounded timeout');
  const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const timer = setTimeout(() => controller.abort(unavailable('insufficient_evidence: proof deadline')), timeoutMs);
  let browser;
  try {
    const before = await readAppRelease(origin, { timeoutMs: remaining() });
    controller.signal.throwIfAborted();
    browser = await launchProofBrowser(engine, { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() }, { signal: controller.signal });
    const page = await browser.newPage();
    let requests = 0, bytes = 0;
    await page.route('**/*', async route => {
      const request = route.request(), target = new URL(request.url());
      if (++requests > 40 || request.method() !== 'GET' || target.origin !== origin) return route.abort();
      if (target.pathname === '/__stage-proof') return route.fulfill({ contentType: 'text/html', body: '<main id="comparison"></main>' });
      if (!/^\/js\/[\w.-]+\.js$/.test(target.pathname)) return route.abort();
      try {
        const response = await proofFetch(target, { signal: controller.signal });
        assert.ok(response.ok && /javascript/.test(response.headers.get('content-type')), 'JavaScript asset');
        const chunks = [];
        for await (const chunk of response.body) { bytes += chunk.length; assert.ok(bytes <= 8 * 1024 * 1024, 'asset byte cap'); chunks.push(chunk); }
        await route.fulfill({ contentType: 'text/javascript', body: Buffer.concat(chunks) });
      } catch { await route.abort().catch(() => {}); }
    });
    await page.goto(`${origin}/__stage-proof`);
    const assertions = await exerciseStage(page, origin);
    const after = await readAppRelease(origin, { timeoutMs: remaining() });
    controller.signal.throwIfAborted();
    assert.deepEqual(after, before, 'unchanged release identity');
    const receipt = { status: 'fixture_only', production_acceptance: false, release: before, assertions, natural_observation: 'insufficient_evidence: unsigned isolated browser has no session-bound visible deal' };
    if (!fixture) throw Object.assign(unavailable(receipt.natural_observation), { receipt });
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'fixture mode is loopback only');
    return receipt;
  } finally { clearTimeout(timer); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--fixture') options.fixture = true;
      else if (args[i] === '--origin') options.origin = args[++i];
      else if (args[i] === '--timeout-ms') options.timeoutMs = Number(args[++i]);
      else throw Error('Usage: --origin URL [--timeout-ms 30000] [--fixture]');
    }
    console.log(JSON.stringify(await prove(options)));
  } catch (error) { if (error.receipt) console.log(JSON.stringify(error.receipt)); console.error(error.message); process.exitCode = error.exitCode || 1; }
}
