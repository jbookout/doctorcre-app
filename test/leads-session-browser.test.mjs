import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { lead, workspace } from './leads-workspace-fixture.mjs';

async function sessionPage(browser, { baseline, actor = () => 'example-partner', getBoard } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const board = { ...workspace(), leads: Array.from({ length: 375 }, (_, i) => lead(i + 1)) };
  const reads = { session: 0, board: 0, workspace: 0 };
  await routeLeads(page, { getBoard: getBoard || (() => board), onRead: () => reads.workspace++ });
  await page.route('http://localhost/api/system-work/session', route => {
    reads.session++;
    return route.fulfill({ json: { actor: { slug: actor() } } });
  });
  await page.route('http://localhost/mcp', async route => {
    const request = route.request().postDataJSON().params;
    if (request.name !== 'deal-room-board') return route.fallback();
    reads.board++;
    const value = { actor: actor(), deals: Array.from({ length: 54 }, (_, i) => ({ id: `synthetic-${i}`, detail: 'Synthetic '.repeat(480) })) };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  });
  if (baseline) await page.route('http://localhost/js/leads-client.js', route => route.fulfill({ contentType: 'text/javascript', body: baseline }));
  return { page, reads };
}

test('Leads uses authenticated sessions and clears the previous actor before loading the next workspace', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  let actor = 'example-partner';
  const { page, reads } = await sessionPage(browser, { actor: () => actor });
  await page.goto('http://localhost/leads');
  await page.locator('#leadBoard[aria-busy="false"]').waitFor();
  assert.equal(await page.locator('.lead-card').count(), 375);
  assert.equal(reads.board, 0);
  const search = page.locator('#leadSearch');
  await search.fill('Example 1');
  actor = 'another-example-partner';
  let release;
  const held = new Promise(resolve => release = resolve);
  await page.route('http://localhost/mcp', async route => {
    if (route.request().postDataJSON().params.name !== 'lead-board') return route.fallback();
    await held;
    return route.fallback();
  });
  await page.locator('#refreshBoard').click();
  await page.waitForFunction(() => document.querySelector('#leadSearch').value === '' && document.querySelectorAll('.lead-card').length === 0);
  release();
  await page.locator('#leadBoard[aria-busy="false"]').waitFor();
  assert.equal(await search.inputValue(), '');
  assert.equal(await page.locator('.lead-card').count(), 375);
  assert.equal(reads.board, 0);
});

test('measure five alternating synthetic browser loads per revision', { skip: !process.env.LEADS_BENCHMARK_BASE }, async t => {
  const baseline = execFileSync('git', ['show', `${process.env.LEADS_BENCHMARK_BASE}:js/leads-client.js`], { encoding: 'utf8' });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const runs = { before: [], after: [] }, counts = { before: [], after: [] };
  for (let i = 0; i < 5; i++) for (const side of ['before', 'after']) {
    let returned;
    const getBoard = process.env.LEADS_BENCHMARK_BACKEND ? async () => {
      const response = await fetch(`${process.env.LEADS_BENCHMARK_BACKEND}/${side}`);
      assert.equal(response.status, 200);
      returned = await response.json();
      return returned;
    } : undefined;
    const { page, reads } = await sessionPage(browser, { baseline: side === 'before' ? baseline : undefined, getBoard });
    const start = performance.now();
    await page.goto('http://localhost/leads');
    await page.locator('#leadBoard[aria-busy="false"]').waitFor();
    runs[side].push(performance.now() - start);
    assert.equal(await page.locator('.lead-card').count(), returned ? 367 : 375);
    assert.equal(reads.workspace, 1);
    assert.equal(reads.board, side === 'before' ? 1 : 0);
    counts[side].push(reads);
    await page.close();
  }
  const report = { fixture: process.env.LEADS_BENCHMARK_BACKEND ? '375 synthetic leads; live disposable PostgreSQL workspace reads through a loopback fixture API; no injected delay' : '375 synthetic leads; 54 synthetic deal records; local routes; no injected delay',
    metric: 'navigation through completed leadBoard, including browser automation', samples_ms: runs, counts,
    median_ms: Object.fromEntries(Object.entries(runs).map(([side, samples]) => [side, [...samples].sort((a, b) => a - b)[2]])) };
  await mkdir('test-artifacts/leads-speed', { recursive: true });
  await writeFile('test-artifacts/leads-speed/browser.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
});
