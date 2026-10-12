import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountBoard } from '../js/progress-board.js';
import { mountCostView } from '../js/progress-board-costs.js';

import costs from './fixtures/progress-board-costs.json' with { type: 'json' };

function costView(data) {
  const dom = new JSDOM('<section></section>');
  const panel = dom.window.document.querySelector('section');
  const view = mountCostView(panel);
  view.update(data);
  const select = (label, value) => {
    const node = panel.querySelector(`[aria-label="${label}"]`);
    node.value = value; node.dispatchEvent(new dom.window.Event('change'));
  };
  return { panel, view, select };
}

test('aggregate budget uses the published system budget independently of provider budgets', () => {
  const { panel, select } = costView({ ...costs, budget_usd: 70 });
  assert.match(panel.querySelector('.cost-metrics').textContent, /Monthly budget\$70\.00/);
  select('Cost provider', 'jev');
  assert.match(panel.querySelector('.cost-metrics').textContent, /Monthly budget\$80\.00/);
});

test('unavailable usage preserves confirmed subscription lower bounds in metrics, daily spend and history', () => {
  const fixture = structuredClone(costs);
  Object.assign(fixture.providers[1], { plan: 'Confirmed subscription', mtd_usd: 0.516129, projection_usd: 4,
    daily: [{ day: '2026-10-04', usd: 0.129032, drivers: { subscription: 0.129032 } },
      { day: '2026-09-20', usd: 0.133333, drivers: { subscription: 0.133333 } }] });
  fixture.months[0] = { month: '2026-09', usd: 54, providers: { jev: 50, neon: 4 } };
  const { panel, select } = costView(fixture);
  assert.match(panel.querySelector('.cost-metrics').textContent, /Known month to date\$12\.52/);
  assert.match(panel.querySelector('.cost-metrics').textContent, /Known projection · incomplete\$97\.00/);
  select('Cost provider', 'neon');
  assert.match(panel.querySelector('.cost-metrics').textContent, /Known month to date\$0\.52/);
  assert.match(panel.querySelector('[data-day="2026-10-04"]').getAttribute('aria-label'), /\$0\.13 known.*incomplete.*subscription/);
  assert.match(panel.textContent, /Coverage incomplete/);
  select('Cost month', '2026-09');
  assert.match(panel.querySelector('.cost-metrics').textContent, /Known monthly spend\$4\.00/);
  assert.match(panel.querySelector('[data-day="2026-09-20"]').getAttribute('aria-label'), /subscription \$0\.13/);
  select('Cost provider', '');
  assert.match(panel.querySelector('.cost-metrics').textContent, /Known monthly spend\$54\.00/);
});

test('published unavailable envelope is visible initially, after ready data, and recovers', () => {
  const unavailable = { schema: costs.schema, state: 'unavailable', reason: 'source_unavailable',
    providers: [], months: [], alerts: [], action: costs.action };
  const { panel, view } = costView(unavailable);
  const check = () => {
    assert.equal(panel.hidden, false);
    assert.match(panel.textContent, /unavailable.*source_unavailable.*Finance Ops/s);
    assert.equal(panel.querySelectorAll('[data-day]').length, 0);
    assert.equal(panel.querySelectorAll('option').length, 0);
    assert.doesNotMatch(panel.textContent, /\$12\.00/);
  };
  check(); view.update(costs); assert.match(panel.textContent, /\$12\.00/);
  view.update(unavailable); check();
  view.update(costs); assert.equal(panel.hidden, false); assert.match(panel.textContent, /\$12\.00/);
  view.update(undefined); assert.equal(panel.hidden, true);
});

for (const [month, through] of [['2026-10', '2026-09-30'], ['2027-01', '2026-12-31']]) {
  test(`month rollover ${month} has no completed or future daily bars`, () => {
    const { panel, view } = costView({ ...costs, month, through });
    assert.equal(panel.querySelectorAll('[data-day]').length, 0);
    assert.match(panel.textContent, /No completed days/);
    view.update({ ...costs, month, through: `${month}-01` });
    assert.equal(panel.querySelectorAll('[data-day]').length, 1);
  });
}

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

test('finite amounts on a partial aggregate are labeled as known lower bounds', async () => {
  const fixture = structuredClone(costs);
  fixture.providers[1] = { ...fixture.providers[1], state: 'partial', mtd_usd: 5, projection_usd: 38.75 };
  fixture.months[0] = { month: '2026-09', usd: 55, providers: { jev: 50, neon: 5 } };
  const { panel, dom } = await board(fixture);
  assert.match(panel.querySelector('.cost-metrics').textContent, /Known month to date\$17\.00/);
  assert.match(panel.querySelector('.cost-metrics').textContent, /Known projection · incomplete\$131\.75/);
  assert.match(panel.textContent, /Coverage incomplete/);
  const month = panel.querySelector('[aria-label="Cost month"]');
  month.value = '2026-09'; month.dispatchEvent(new dom.window.Event('change'));
  assert.match(panel.querySelector('.cost-metrics').textContent, /Known monthly spend\$55\.00/);
});

test('finite zero stays a known lower bound when usage is unavailable', async () => {
  const fixture = structuredClone(costs);
  fixture.providers[1] = { ...fixture.providers[1], state: 'partial', plan: 'Unconfirmed',
    reason: 'subscription plan/price unconfirmed', mtd_usd: 0, projection_usd: 0 };
  const { panel, dom, app } = await board(fixture);
  const provider = panel.querySelector('[aria-label="Cost provider"]');
  provider.value = 'neon'; provider.dispatchEvent(new dom.window.Event('change'));
  assert.match(panel.querySelector('.cost-metrics').textContent, /Known month to date\$0\.00/);
  assert.match(panel.querySelector('.cost-metrics').textContent, /Known projection · incomplete\$0\.00/);
  assert.match(panel.textContent, /subscription plan\/price unconfirmed/);
  assert.match(panel.textContent, /Amounts exclude unknown costs/);
  assert.match(panel.querySelector('[data-day="2026-10-01"]').getAttribute('aria-label'), /Unavailable/);
  assert.match(panel.querySelector('.cost-chart > text').textContent, /Daily spend unavailable/);
  fixture.providers[1].state = 'unavailable';
  await app.refresh();
  assert.match(panel.querySelector('.cost-metrics').textContent, /Known month to date\$0\.00/);
  assert.match(panel.querySelector('.cost-metrics').textContent, /Known projection · incomplete\$0\.00/);
  assert.match(panel.textContent, /Amounts exclude unknown costs/);
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
