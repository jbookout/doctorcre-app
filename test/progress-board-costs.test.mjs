import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountBoard } from '../js/progress-board.js';

import costs from './fixtures/progress-board-costs.json' with { type: 'json' };

async function board(costData = costs) {
  const html = await readFile(new URL('../progress-board.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://app.doctorcre.com/progress-board?board=demo' });
  const client = { readProgressBoard: async () => ({ snapshot: { board_id: 'demo', version: 1, snapshot_json: { tasks: {}, costs: costData } }, questions: [] }) };
  const app = mountBoard({ window: dom.window, client, storage: null, setInterval: () => 0, setTimeout: () => 0 });
  await app.refresh();
  return { dom, app, client, panel: dom.window.document.querySelector('#board-costs') };
}

test('published cost view exposes provider/day spend, missing coverage and bound action', async () => {
  const { panel, dom } = await board();
  assert.ok(panel, 'cost panel exists');
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /\$12\.00/);
  assert.match(panel.textContent, /NEON_BILLING_READ_TOKEN missing/);
  assert.match(panel.textContent, /Finance Ops: inspect provider driver/);
  assert.equal(panel.querySelectorAll('svg [data-day]').length, 4, 'all complete UTC days are represented');
  assert.match(panel.textContent, /review.*\$11\.00/);
  const provider = panel.querySelector('[aria-label="Cost provider"]');
  provider.value = 'jev'; provider.dispatchEvent(new dom.window.Event('change'));
  assert.match(panel.textContent, /\$93\.00/);
  assert.match(panel.textContent, /\$80\.00/);
});

test('a denied board read clears provider amounts and cost controls', async () => {
  const { panel, app, client } = await board();
  assert.match(panel.textContent, /\$12\.00/);
  client.readProgressBoard = async () => { throw Object.assign(new Error('denied'), { status: 401 }); };
  await app.refresh();
  assert.equal(panel.hidden, true);
  assert.doesNotMatch(panel.textContent, /\$12\.00|NEON_BILLING_READ_TOKEN|review/);
  assert.equal(panel.querySelectorAll('option').length, 0);
});

test('malformed optional cost data cannot stop the board render', async () => {
  const { panel, app } = await board({ ...costs, providers: [null] });
  assert.equal(panel.hidden, true);
  assert.equal(app.view.title, 'Progress board');
});

test('provider and month controls retain selection on refresh and never render provider text as HTML', async () => {
  const fixture = structuredClone(costs);
  fixture.providers[0].label = '<img src=x onerror=alert(1)>';
  const { panel, dom, app } = await board(fixture);
  const provider = panel.querySelector('[aria-label="Cost provider"]');
  const month = panel.querySelector('[aria-label="Cost month"]');
  provider.value = 'jev'; provider.dispatchEvent(new dom.window.Event('change'));
  month.value = '2026-09'; month.dispatchEvent(new dom.window.Event('change'));
  assert.match(panel.textContent, /Monthly spend\$50\.00/);
  assert.equal(panel.querySelectorAll('svg [data-day]').length, 30);
  assert.match(panel.querySelector('[data-day="2026-09-20"]').getAttribute('aria-label'), /\$50\.00/);
  assert.equal(panel.querySelectorAll('img').length, 0);
  fixture.observed_at = '2026-10-05T09:00:00Z';
  await app.refresh();
  assert.equal(provider.value, 'jev'); assert.equal(month.value, '2026-09');
});
