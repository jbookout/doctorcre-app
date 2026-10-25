// PR184 V1 residual controls and the Updates audit (findings 15, 21, 25b),
// exercised through each page's real boot: the shipped modules load in
// Chromium and only the in-memory fixture adapter is wrapped with synthetic
// hooks. No page source is sliced, and no request leaves the machine.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, fixtureServer, settles } from './browser-harness.mjs';

let server, origin;
before(async () => { server = await fixtureServer(); origin = server.origin; });
after(() => server?.close());

const viewports = [{ width: 1440, height: 960 }, { width: 390, height: 844 }];

async function open(t, { viewport = viewports[0], reducedMotion = 'no-preference', hooks = '', init = () => {} } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport, reducedMotion, timezoneId: 'UTC' });
  await page.clock.install({ time: new Date('2026-10-12T15:00:00Z') });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(init);
  await page.route('**/{api/system-work/session,auth/session}', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/js/fixture-client.js', async route => {
    let source = await readFile(new URL('../js/fixture-client.js', import.meta.url), 'utf8');
    source = source.replace('export async function createFixtureClient', 'async function originalFixture');
    source += `\nexport async function createFixtureClient(opts){const c=await originalFixture(opts);${hooks}return c;}`;
    await route.fulfill({ contentType: 'text/javascript', body: source });
  });
  return { page, errors };
}

const CHAT = '22222222-2222-4222-8222-222222222222';
const updatesHooks = `
c.notificationFeed=async()=>({ok:true,unread_count:3,quiet_now:false,notifications:[
  {id:'11111111-1111-4111-8111-111111111111',severity:'action_required',reason:'Synthetic deal needs a reply',subject_type:'deal',subject_ref:'D-DEMO-123',deep_link:'/deals?id=synthetic-deal',created_at:'2026-10-12T14:20:00Z',read_at:null,delivery:[],quiet_suppressed:false},
  {id:'33333333-3333-4333-8333-333333333333',severity:'failure',reason:'Synthetic signal failed',subject_type:'internal_kind',subject_ref:'raw-reference',deep_link:'/signals/synthetic-signal',created_at:'2026-10-12T13:05:00Z',read_at:null,delivery:[],quiet_suppressed:false},
  {id:'44444444-4444-4444-8444-444444444444',severity:'action_required',reason:'Synthetic chat waiting',subject_type:'doc_conversation',subject_ref:'${CHAT}',deep_link:'/doc-conversations/${CHAT}',created_at:'2026-10-12T12:00:00Z',read_at:null,delivery:[],quiet_suppressed:false}]});
c.getChanges=async cursor=>cursor==='synthetic-cursor'?{ok:true,cursor:'synthetic-cursor',events:[]}:{ok:true,cursor:'synthetic-cursor',events:[
  {actor:'joe',verb:'set-next-step',subject_type:'deal',subject_id:'synthetic-record-id',recorded_at:'2026-10-12T14:00:00Z'},
  {actor:'f00dfeed-0000-4000-8000-000000000001',verb:'patch-deal-field',field:'phase',subject_type:'deal',subject_id:'synthetic-record-two',recorded_at:'2026-10-12T14:10:00Z'}]};
const pref=await c.notificationPreferences();
await c.setNotificationPreference({idempotency_key:'synthetic-pref-seed',base_version:pref.version,device_opt_in:true,quiet_hours_start:'22:00',quiet_hours_end:'07:30',timezone:'UTC'});
window.prefWrites=[];const write=c.setNotificationPreference;c.setNotificationPreference=async args=>{window.prefWrites.push(args);return write(args);};
`;

const visibleText = locator => locator.evaluate(node => {
  const copy = node.cloneNode(true);
  copy.querySelectorAll('details').forEach(details => details.remove());
  return copy.textContent;
});

for (const viewport of viewports) test(`V1 audit 15/21/25b: Updates uses human labels, Details, contextual help and AM/PM at ${viewport.width}px`, async t => {
  const { page, errors } = await open(t, { viewport, hooks: updatesHooks });
  await page.goto(origin + '/updates', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('#feedList > li');
  await settles(async () => assert.equal(await cards.count(), 3));

  // Finding 15: a human record label and action; the kind, reference and route sit in collapsed Details.
  const deal = cards.nth(0);
  assert.equal(await deal.locator('.note-subject').textContent(), 'Deal');
  const link = deal.locator('.note-link a');
  assert.equal(await link.textContent(), 'Open deal');
  assert.equal(await link.getAttribute('href'), '/deals?id=synthetic-deal');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await link.getAttribute('rel'), 'noopener');
  const details = deal.locator('details.record-details');
  assert.equal(await details.evaluate(node => node.open), false);
  assert.equal(await details.locator('dd').first().isVisible(), false);
  await details.locator('summary').click();
  assert.equal(await details.evaluate(node => node.open), true);
  assert.match(await details.textContent(), /D-DEMO-123/);
  assert.match(await details.textContent(), /\/deals\?id=synthetic-deal/);
  const signal = cards.nth(1);
  assert.equal(await signal.locator('.note-subject').textContent(), 'Record');
  assert.equal(await signal.locator('.note-link a').count(), 0);
  assert.equal(await signal.locator('.note-link').textContent(), 'Record unavailable in this app');
  const chat = cards.nth(2);
  assert.equal(await chat.locator('.note-subject').textContent(), 'Doc conversation');
  assert.equal(await chat.locator('.note-link a').textContent(), 'Open conversation');
  assert.equal(await chat.locator('.note-link a').getAttribute('href'), `/doc-chats?id=${CHAT}`);
  for (let i = 0; i < 3; i++) {
    const text = await visibleText(cards.nth(i));
    assert.doesNotMatch(text, /D-DEMO-123|raw-reference|internal_kind|synthetic-signal|doc_conversation|\/deals|\/doc-|[0-9a-f]{8}-[0-9a-f]{4}-/);
    assert.match(text, /\d:\d\d (AM|PM)/);
  }

  // Activity names people and actions; identifiers and operation codes live in Details.
  const activity = page.locator('#activityList > li');
  await settles(async () => assert.equal(await activity.count(), 2));
  assert.equal(await activity.nth(0).locator('h3').textContent(), 'Recorded actor · Phase');
  assert.equal(await activity.nth(1).locator('h3').textContent(), 'Joe · Set next step');
  for (let i = 0; i < 2; i++) assert.doesNotMatch(await visibleText(activity.nth(i)), /f00dfeed|synthetic-record|patch-deal-field|set-next-step/);
  await activity.nth(0).locator('summary').click();
  assert.match(await activity.nth(0).locator('details').textContent(), /f00dfeed-0000-4000-8000-000000000001[\s\S]*patch-deal-field/);

  // Finding 21: no exposure card heading without a body.
  assert.equal(await page.locator('[data-section="exposure"], #exposureStatement, #exposureTitle').count(), 0);
  for (const heading of await page.locator('main h2').all()) assert.notEqual((await heading.textContent()).trim(), '');

  // Finding 25b: guidance is collapsed contextual help, never a caption under a heading.
  assert.equal(await page.locator('#vocabularyLine, #quietHoursEffect, #quietHoursScope, #activityBlock > p.caption').count(), 0);
  const help = page.locator('details.context-help');
  assert.equal(await help.evaluate(node => node.open), false);
  assert.equal(await help.locator('summary').textContent(), 'About updates');
  assert.equal(await help.getByText(/addressed to you/).isVisible(), false);
  await help.locator('summary').click();
  assert.equal(await help.getByText(/addressed to you/).isVisible(), true);
  assert.equal(await help.getByText(/Acknowledging clears the notification/).isVisible(), true);

  // Quiet hours read and summarize in AM/PM; the version is in Details only.
  await settles(async () => assert.equal(await page.locator('#quietStart').inputValue(), '10:00 PM'));
  assert.equal(await page.locator('#quietEnd').inputValue(), '7:30 AM');
  assert.equal(await page.locator('#prefSummary').textContent(), 'Quiet hours 10:00 PM to 7:30 AM UTC · device push on');
  assert.match(await page.locator('#prefVersion').textContent(), /^Version \d+$/);
  assert.equal(await page.locator('#prefVersion').isVisible(), false);
  assert.ok(await page.locator('#prefVersion').evaluate(node => node.closest('details.record-details')));
  assert.doesNotMatch(await page.locator('#prefForm').evaluate(node => {
    const copy = node.cloneNode(true); copy.querySelectorAll('details').forEach(d => d.remove()); return copy.textContent;
  }), /version/i);

  // A typed AM/PM time is written as the canonical clock under the read version.
  await page.locator('#quietStart').fill('9 pm');
  await page.locator('#prefSave').click();
  await settles(async () => assert.equal(await page.evaluate(() => window.prefWrites.length), 1));
  const [write] = await page.evaluate(() => window.prefWrites);
  assert.equal(write.quiet_hours_start, '21:00');
  assert.equal(write.quiet_hours_end, '07:30');
  assert.equal(typeof write.base_version, 'number');
  await settles(async () => assert.equal(await page.locator('#prefMessage').textContent(), 'Saved'));
  assert.equal(await page.locator('#quietStart').inputValue(), '9:00 PM');
  assert.equal(await page.locator('.toast').textContent(), 'Save notification preferences');
  assert.equal(await page.locator('#receiptDock .receipt[data-state="confirmed"]').count(),0);

  // An unreadable time is refused in words, and nothing is sent.
  await page.locator('#quietEnd').fill('25:00');
  await page.locator('#prefSave').click();
  await settles(async () => assert.match(await page.locator('#prefMessage').textContent(), /AM or PM/));
  assert.equal(await page.evaluate(() => window.prefWrites.length), 1);

  // Acknowledging is summarized without the notification identifier.
  await deal.locator('[data-ack]').click();
  const summaries = () => page.locator('#receiptDock .receipt b').allTextContents();
  await settles(async () => assert.ok((await summaries()).includes('Acknowledge notification')));
  for (const summary of await summaries()) assert.doesNotMatch(summary, /version|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  assert.deepEqual(errors, []);
});

for (const reducedMotion of ['no-preference', 'reduce']) test(`Updates disclosures ease open with a ${reducedMotion} motion fallback`, async t => {
  const { page, errors } = await open(t, { reducedMotion, hooks: updatesHooks });
  await page.goto(origin + '/updates', { waitUntil: 'domcontentloaded' });
  const help = page.locator('details.context-help');
  await help.locator('summary').click();
  const motion = await help.locator('p').first().evaluate(node => getComputedStyle(node).animationName);
  assert.equal(motion, reducedMotion === 'reduce' ? 'none' : 'details-reveal');
  // The app's own motion setting reduces it too.
  await page.evaluate(() => document.documentElement.setAttribute('data-motion', 'reduced'));
  assert.equal(await help.locator('p').first().evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.deepEqual(errors, []);
});

for (const viewport of viewports) test(`QA-010 the preferences anchor waits for the first successful read and reveals once at ${viewport.width}px`, async t => {
  const { page, errors } = await open(t, { viewport, init: () => { window.refusePreferences = true; },
    hooks: `const read=c.notificationPreferences;c.notificationPreferences=async()=>{if(window.refusePreferences)throw Object.assign(new Error('synthetic outage'),{status:503});window.preferenceReads=(window.preferenceReads||0)+1;return read();};` });
  await page.goto(origin + '/updates#prefForm', { waitUntil: 'domcontentloaded' });
  await settles(async () => assert.equal(await page.locator('#prefState').getAttribute('data-state'), 'unavailable'));
  assert.equal(await page.locator('#prefForm').isHidden(), true);
  assert.equal(await page.evaluate(() => scrollY), 0, 'a failed read does not move the page');
  await page.evaluate(() => { window.refusePreferences = false; window.dispatchEvent(new Event('online')); });
  await settles(async () => assert.equal(await page.locator('#deviceOptIn').isEnabled(), true));
  const revealed = async () => page.evaluate(() => {
    const box = document.querySelector('#deviceOptIn').getBoundingClientRect();
    const bar = document.querySelector('.app-layout-tabbar')?.getBoundingClientRect();
    return box.top >= (bar && bar.bottom < innerHeight / 2 ? bar.bottom : 0) && box.bottom <= innerHeight
      && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === document.querySelector('#deviceOptIn');
  });
  await settles(async () => assert.equal(await revealed(), true));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  assert.equal(await page.evaluate(() => scrollY), 0);
  const reads = await page.evaluate(() => window.preferenceReads);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await settles(async () => assert.ok(await page.evaluate(() => window.preferenceReads) > reads));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => scrollY), 0, 'a later refresh does not anchor again');
  assert.deepEqual(errors, []);
});

for (const viewport of viewports) test(`QA-009 Doc Chats conversation controls are disabled until a conversation is open at ${viewport.width}px`, async t => {
  const { page, errors } = await open(t, { viewport });
  await page.goto(origin + '/doc-chats', { waitUntil: 'domcontentloaded' });
  const controls = ['#renameInput', '#renameSave', '#pinToggle', '#archiveToggle'];
  const rows = page.locator('#conversationList button[data-open]');
  await settles(async () => assert.ok(await rows.count() >= 2));
  for (const id of controls) assert.equal(await page.locator(id).isDisabled(), true, id);
  await rows.nth(1).click();
  await settles(async () => { for (const id of controls) assert.equal(await page.locator(id).isEnabled(), true, id); });
  await page.goBack();
  await settles(async () => { for (const id of controls) assert.equal(await page.locator(id).isDisabled(), true, id); });
  assert.match(await page.locator('#turnsStateTitle').textContent(), /select|choose|open/i);
  assert.deepEqual(errors, []);
});

test('QA-008 Deals freshness says unavailable after failed reads and recovers to an AM/PM update', async t => {
  const { page, errors } = await open(t, { init: () => { window.refuseBoard = true; },
    hooks: `const read=c.getBoard;c.getBoard=async(...args)=>{if(window.refuseBoard)throw Object.assign(new Error('synthetic outage'),{status:503});return read.apply(c,args);};` });
  await page.goto(origin + '/deals', { waitUntil: 'domcontentloaded' });
  await settles(async () => assert.equal(await page.locator('#boardAsOf').textContent(), 'Unavailable'));
  assert.doesNotMatch(await page.locator('#boardAsOf').textContent(), /Updating/);
  await page.locator('#listView').click();
  assert.equal(await page.locator('#boardAsOf').textContent(), 'Unavailable');
  await page.evaluate(() => { window.refuseBoard = false; });
  await page.evaluate(async () => (await import('/js/pipeline.js')).state.boardSync.refreshBoard({ reason: 'test' }));
  await settles(async () => assert.match(await page.locator('#boardAsOf').textContent(), /^Updated \d{1,2}:\d\d (AM|PM)$/));
  assert.deepEqual(errors.filter(message => !/synthetic outage/.test(message)), []);
});
