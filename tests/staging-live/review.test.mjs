import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chromium, fixtureServer } from '../../test/browser-harness.mjs';
import { inventory, pressControl, sweepScreen } from '../../scripts/e2e-staging/controls.mjs';

test('a handlerless control in the mounted app stays DEAD while Doc ticks with its dialog closed', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.origin}/?demo=1`);
  await page.locator('#docPresence').waitFor();
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'handlerless'; button.textContent = 'Synthetic dead action';
    document.querySelector('main').append(button);
  });
  const row = (await inventory(page)).find(row => row.selector === '#handlerless');
  const result = await pressControl(page, row);
  assert.equal(await page.locator('#docDetail').evaluate(dialog => dialog.open), false);
  assert.equal(result.status, 'DEAD');
  assert.deepEqual(result.signals, []);
  const doc = (await inventory(page)).find(row => row.selector === '#docOpen');
  assert.equal((await pressControl(page, doc)).status, 'OBSERVED');
  assert.equal(await page.locator('#docDetail').evaluate(dialog => dialog.open), true);
});

test('idle visible rendering, hidden alerts and unrelated aria cannot credit a dead control', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<main><button id="dead">Dead</button><button id="live" onclick="setTimeout(()=>document.querySelector('#out').textContent='Saved',10)">Live</button><output id="out"></output><time id="tick"></time><button id="other" aria-pressed="false">Other</button></main><dialog><p role="status" id="hidden"></p></dialog><script>setInterval(()=>{document.querySelector('#tick').textContent=String(Date.now());document.querySelector('#hidden').textContent='Idle';document.querySelector('#other').setAttribute('aria-pressed',String(Date.now()%2===0))},15)</script>`);
  const rows = await inventory(page);
  assert.equal((await pressControl(page, rows.find(row => row.selector === '#dead'), { waitMs: 80 })).status, 'DEAD');
  assert.equal((await pressControl(page, rows.find(row => row.selector === '#live'), { waitMs: 80 })).status, 'OBSERVED');
});

test('idle polling cannot credit a dead control while a new interaction request counts', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://synthetic.test/**', route => route.fulfill({ body: 'Synthetic response', headers: { 'access-control-allow-origin': '*' } }));
  await page.setContent(`<main><button id="dead">Dead</button><button id="live" onclick="fetch('https://synthetic.test/save')">Save</button></main><script>setInterval(()=>fetch('https://synthetic.test/poll').catch(()=>{}),15)</script>`);
  const rows = await inventory(page);
  assert.equal((await pressControl(page, rows.find(row => row.selector === '#dead'), { waitMs: 80 })).status, 'DEAD');
  assert.equal((await pressControl(page, rows.find(row => row.selector === '#live'), { waitMs: 80 })).status, 'OBSERVED');
});

test('a one-off idle update during the observation window is not an interaction', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main><button id="dead">Dead</button><output id="out"></output></main>');
  await page.evaluate(() => setTimeout(() => { document.querySelector('#out').textContent = 'Unrelated update'; }, 160));
  assert.equal((await pressControl(page, (await inventory(page))[0], { waitMs: 120 })).status, 'DEAD');
});

test('fresh replay discovers Pin and dead Unpin without duplicating unrelated controls', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const rename of [true, false]) {
    const result = await sweepScreen({
      freshPage: async () => {
        const page = await browser.newPage();
        await page.setContent(`<main><button id="pinToggle" aria-pressed="false" onclick="if(this.getAttribute('aria-pressed')==='false'){this.setAttribute('aria-pressed','true');${rename ? "this.textContent='Unpin'" : ''}}">Pin</button><button id="unrelated">Unrelated</button></main>`);
        return page;
      }, screen: { path: '/', name: 'Synthetic toggles' }, target: 'test', waitMs: 20,
    });
    assert.equal(result.failure, null); assert.equal(result.exhausted, false);
    const toggle = result.controls.filter(row => row.selector === '#pinToggle');
    assert.deepEqual(toggle.map(row => row.status), ['OBSERVED', 'DEAD']);
    assert.deepEqual(toggle[1].openers, ['Pin']);
    assert.equal(result.controls.filter(row => row.selector === '#unrelated').length, 1);
  }
});

test('native checkbox discovery covers both checked states', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const result = await sweepScreen({
    freshPage: async () => { const page = await browser.newPage(); await page.setContent('<main><input id="check" type="checkbox"><button id="other">Other</button></main>'); return page; },
    screen: { path: '/', name: 'Synthetic checkbox' }, target: 'test', waitMs: 20,
  });
  assert.equal(result.exhausted, false);
  assert.equal(result.controls.filter(row => row.selector === '#check').length, 2);
  assert.equal(result.controls.filter(row => row.selector === '#other').length, 1);
});

test('recovery goals pass the installed explorer input validation and scope records to the workspace', async () => {
  const { explorationGoal } = await import('../../scripts/e2e-staging/explore.mjs');
  assert.equal(typeof explorationGoal, 'function');
  const { explore } = await import('../../node_modules/e2e/dist/explore/index.js');
  // A config getter sentinel proves the real runner accepted the goal before
  // loading config; it cannot launch a browser or make a model call.
  const sentinel = new Error('Reached config after goal validation');
  const records = Object.fromEntries(['party', 'client', 'deal', 'invoice', 'lead_party', 'lead', 'conversation', 'tour'].map(record => [record, { id: randomUUID(), name: `Synthetic QA ${record}`, ...(['client','lead'].includes(record) ? { ref: record === 'client' ? 'C-123' : 'L-123' } : {}) }]));
  const recovery = Object.keys(records).flatMap(record => Array.from({ length: 3 }, () => ({ record, id: records[record].id, name: records[record].name, reason: 'closed', coverage_limited: true, guidance: 'Use the normal UI to reopen or create an invented record.', current_name: 'Renamed synthetic record', ...(record === 'deal' ? { current_owner: 'dell', current_phase: 'closed' } : record === 'conversation' ? { current_visibility: 'team' } : {}) })));
  for (const [path, expected] of [['/', 'deal'], ['/doc-chats', 'conversation'], ['/leads', 'lead'], ['/invoices', 'invoice'], ['/tours', 'tour'], ['/status', null]]) {
    const goal = explorationGoal({ path, name: path }, { records, needs_restore: recovery });
    assert.ok(goal.length <= 2000, `${path}: ${goal.length} characters`);
    assert.match(goal, /Staging only/);
    if (expected) { assert.ok(goal.includes(records[expected].id)); assert.match(goal, /closed/); }
    if (path === '/doc-chats') assert.ok(!goal.includes(records.deal.id));
    if (path === '/doc-chats') assert.match(goal, /team/);
    if (path === '/') assert.match(goal, /dell/);
    if (path === '/status') assert.ok(!goal.includes(records.client.id));
    await assert.rejects(explore({ goal, get rawConfig() { throw sentinel; } }), error => error === sentinel);
  }
  const long = structuredClone(records); for (const row of Object.values(long)) row.name = 'Synthetic '.repeat(60);
  const goal = explorationGoal({ path: '/', name: 'Home' }, { records: long, needs_restore: recovery });
  assert.ok(goal.length <= 2000);
  assert.ok(goal.includes(records.deal.id));
  await assert.rejects(explore({ goal, get rawConfig() { throw sentinel; } }), error => error === sentinel);
});
