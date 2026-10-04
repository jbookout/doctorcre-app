import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { createFixtureClient } from '../js/fixture-client.js';

// Chromium stands in for Chrome and the installed app (same engine, same
// renderer key path); WebKit stands in for Safari.
const root = new URL('../', import.meta.url);
const contract = JSON.parse(await readFile(new URL('contracts/app-routes.v1.json', root)));
const METHODS = { 'deal-room-board':'getBoard', 'get-deal-room':'getDeal', 'deal-room-changes':'getChanges', 'list-doc-suggestions':'listDocSuggestions', 'find':'find', 'find-and-catch-up':'findAndCatchUp', 'read-invoice-tracker':'getInvoiceTracker', 'record-commission-receipt':'markInvoicePaid' };
const TOUR_ID = '33333333-3333-4333-8333-333333333333';

async function setup(t, engine, { width = 1440 } = {}) {
  const browser = await engine.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(10000);
  const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json', root))).toString('base64')}` });
  const calls = [], errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/mcp') {
      const { name, arguments: args } = request.postDataJSON().params; calls.push({ name, args });
      let value = { ok: true };
      if (name === 'patch-deal-field') value = { ok: true, event_id: 'e-command', event_recorded_at: new Date().toISOString() };
      else if (name === 'lead-board') value = { leads: [], stages: [], as_of: new Date().toISOString() };
      else if (name === 'claim-card') value = { claimable: 0, candidates: [], needs_contact_count: 0 };
      else if (METHODS[name]) {
        value = await fixture[METHODS[name]](name === 'get-deal-room' ? args.deal : name === 'deal-room-changes' ? args.cursor : args);
        if (name === 'get-deal-room') value = { ...value.deal, deal_id: value.deal.id, thread: value.thread, critical_dates: value.critical_dates.map(row => ({ ...row, due_on: row.date })), next_actions: value.next_actions, activities: value.activities, events: [] };
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }) });
    }
    if (url.pathname === '/api/tours/library') return route.fulfill({ json: { tours: [{ id: TOUR_ID, name: 'Demo Harbor surgical tour', status: 'draft' }] } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    const file = contract.routes[url.pathname] || url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/deals?mode=live', { waitUntil: 'domcontentloaded' });
  await page.locator('#docPresence').waitFor();
  // The bookmark binding is the platform's: Command on a Mac, Control elsewhere.
  const mod = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
  await page.evaluate(() => { window.keyLog = []; window.addEventListener('keydown', event => window.keyLog.push({ code: event.code, prevented: event.defaultPrevented })); });
  const isOpen = () => page.locator('#docDetail').evaluate(node => node.open);
  const focused = () => page.evaluate(() => document.activeElement?.id);
  return { page, calls, errors, mod, isOpen, focused };
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${name}: Cmd/Ctrl+D and +K open the same Doc; a Command key alone never does`, async t => {
    const { page, errors, mod, isOpen, focused } = await setup(t, engine);
    // A right Command held alone (system dictation) opens nothing and is never claimed.
    await page.keyboard.down('MetaRight'); await page.waitForTimeout(700); await page.keyboard.up('MetaRight');
    assert.equal(await isOpen(), false);
    assert.ok((await page.evaluate(() => window.keyLog)).every(entry => !entry.prevented));
    // A quick chord with the right-hand modifier opens Doc, and the bookmark default is prevented.
    await page.keyboard.down(`${mod}Right`); await page.keyboard.press('KeyD'); await page.keyboard.up(`${mod}Right`);
    assert.equal(await isOpen(), true);
    assert.equal(await focused(), 'docAsk');
    assert.deepEqual((await page.evaluate(() => window.keyLog)).filter(entry => entry.code === 'KeyD'), [{ code: 'KeyD', prevented: true }]);
    assert.equal(await page.locator('#docDetail').count(), 1);
    assert.equal(await page.locator('dialog[open]').count(), 1);
    // Holding right Command inside the open bar keeps it open and focused; dictated text lands in the input.
    await page.keyboard.down('MetaRight'); await page.waitForTimeout(700); await page.keyboard.insertText('surgical'); await page.keyboard.up('MetaRight');
    assert.equal(await isOpen(), true);
    assert.equal(await focused(), 'docAsk');
    assert.equal(await page.locator('#docAsk').inputValue(), 'surgical');
    await page.locator('#docResults [data-doc-result]').first().waitFor();
    assert.match(await page.locator('#docResults').innerText(), /Demo Surgical Practice[\s\S]*Deal/i);
    assert.match(await page.locator('#docResults').innerText(), /Demo Harbor surgical tour[\s\S]*Tour/i);
    // Escape backs out one step at a time, then returns focus to Doc's own icon.
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#docAsk').inputValue(), ''); assert.equal(await isOpen(), true);
    await page.keyboard.press('Escape');
    // The native close event is queued after the key; focus returns when it runs.
    assert.equal(await isOpen(), false); await page.waitForFunction(() => document.activeElement?.id === 'docOpen');
    // Cmd/Ctrl+K is the fallback everywhere, including from a page text field.
    await page.locator('#docOpen').focus();
    await page.keyboard.press(`${mod}+KeyK`);
    assert.equal(await isOpen(), true); assert.equal(await focused(), 'docAsk');
    await page.keyboard.press('Escape');
    // Enter on a found record opens it.
    await page.keyboard.press(`${mod}+KeyD`);
    await page.keyboard.type('surgical practice');
    await page.locator('#docResults [data-doc-result]').first().waitFor();
    await Promise.all([page.waitForURL(/\/deals\?deal=d14$/), page.keyboard.press('Enter')]);
    assert.deepEqual(errors, []);
  });

  test(`${name}: plain words move a deal directly and stage money for one tap`, async t => {
    const { page, calls, errors, mod } = await setup(t, engine);
    await page.keyboard.press(`${mod}+KeyD`);
    await page.keyboard.type('move demo dental north to LOI');
    await page.locator('#docResults [data-doc-result]').first().waitFor();
    assert.match(await page.locator('#docResults').innerText(), /Move Demo Dental North to Negotiating[\s\S]*Prospective Client → Negotiating[\s\S]*Move/i);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /moved to Negotiating/.test(document.querySelector('#docCommandStatus')?.textContent));
    const moves = calls.filter(call => call.name === 'patch-deal-field');
    assert.equal(moves.length, 1);
    assert.equal(moves[0].args.deal, 'd01'); assert.equal(moves[0].args.field, 'phase'); assert.equal(moves[0].args.value, 'negotiation');
    await page.locator('#docAsk').fill('mark oak purchase paid');
    await page.locator('#docResults [data-doc-result]').first().waitFor();
    await page.keyboard.press('Enter');
    await page.locator('#docStagedApprove').waitFor();
    assert.match(await page.locator('#docStaged').innerText(), /Mark Demo Oak Purchase paid[\s\S]*\$18,500\.00 · received [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    assert.equal(await page.locator('#docResults').isVisible(), false);
    assert.equal(calls.filter(call => call.name === 'record-commission-receipt').length, 0);
    await page.locator('#docStagedApprove').click();
    await page.waitForFunction(() => /marked paid/.test(document.querySelector('#docCommandStatus')?.textContent));
    const receipts = calls.filter(call => call.name === 'record-commission-receipt');
    assert.equal(receipts.length, 1); assert.equal(receipts[0].args.base_version, 1);
    assert.deepEqual(errors, []);
  });
}

test('command bar renders wide on desktop and fits a phone without horizontal scroll', async t => {
  const { page, mod } = await setup(t, chromium);
  await mkdir(new URL('test-artifacts/w11/', root), { recursive: true });
  await page.keyboard.press(`${mod}+KeyD`);
  await page.keyboard.type('pensacola');
  await page.locator('#docResults [data-doc-result]').nth(2).waitFor();
  assert.ok(await page.locator('#docDetail').evaluate(node => node.getBoundingClientRect().width) > 900);
  await page.screenshot({ path: new URL('test-artifacts/w11/command-search-desktop.png', root).pathname, animations: 'disabled' });
  await page.locator('#docAsk').fill('mark oak purchase paid');
  await page.locator('#docResults [data-doc-result]').first().click();
  await page.locator('#docStagedApprove').waitFor();
  await page.screenshot({ path: new URL('test-artifacts/w11/command-staged-desktop.png', root).pathname, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#docAsk').fill('pensacola');
  await page.locator('#docResults [data-doc-result]').nth(2).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('#docDetail').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: new URL('test-artifacts/w11/command-search-phone.png', root).pathname, animations: 'disabled' });
});

test('PR142 R14 phone results retain visible and accessible type names',async t=>{
 const {page,mod}=await setup(t,chromium,{width:390});await page.keyboard.press(`${mod}+KeyD`);await page.locator('#docAsk').fill('surgical');await page.locator('#docResults [data-doc-result]').first().waitFor();
 assert.equal(await page.locator('.doc-result-kind').first().isVisible(),true);assert.match(await page.locator('#docResults').ariaSnapshot(),/Deal/);
});
test('PR142 R16 fixture command writes reach the displayed board client',async t=>{
 const {page,mod}=await setup(t,chromium);await page.goto('http://localhost/deals?view=board');await page.locator('.kanban-card[data-id="d14"]').waitFor();await page.keyboard.press(`${mod}+KeyD`);await page.locator('#docAsk').fill('move surgical practice to LOI');await page.locator('#docResults [data-doc-result]').first().waitFor();await page.keyboard.press('Enter');await page.waitForFunction(()=>/moved to/.test(document.querySelector('#docCommandStatus').textContent));
 const phase=await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');return (await state.client.getBoard()).deals.find(d=>d.id==='d14').phase;});assert.equal(phase,'Negotiation');
});
test('PR142 R1 closing destination uses required outcome and date completion flow',async t=>{
 const {page}=await setup(t,chromium);await page.goto('http://localhost/deals?deal=d14&complete=closed');await page.locator('#completionDialog[open]').waitFor();assert.equal(await page.locator('#completionOutcomeField').isVisible(),true);assert.ok(await page.locator('#completionClosedOn').inputValue());await page.locator('#completionConfirm').click();assert.match(await page.locator('#completionErrors').innerText(),/Choose the outcome/);
});
