import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, waitForAsync } from './browser-harness.mjs';
const root = new URL('../', import.meta.url);
const phases = ['On Deck', 'Research', 'Site selection', 'Negotiation', 'Legal', 'Diligence', 'Closing', 'Closed'];
async function open(t, { width = 1440, height = 960, reducedMotion = 'no-preference', many = false } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const seed = JSON.parse(await readFile(new URL('data/board-seed.json', root), 'utf8'));
  seed.deals.forEach((d, i) => Object.assign(d, { phase: phases[i % 8], next_step: 'Confirm the next appointment', last_touch: '2026-10-01', last_review_at: '2026-10-01T16:00:00Z', next_date: null, attention: false }));
  seed.deals.find(d => d.id === 'd14').phase = 'Negotiation';
  seed.deals.find(d => d.id === 'd20').phase = 'Closed';
  seed.deals.find(d => d.id === 'd23').invoiced_on = '2026-10-01';
  seed.seed_events = [{ id: 'auto-loi', actor: 'claude', verb: 'patch-deal-field', subject_type: 'deal', subject_id: 'd14', field: 'phase', old_value: 'Research', new_value: 'Negotiation', automatic: true, change_reason: 'LOI sent', evidence_date: '2026-10-03', recorded_at: '2026-10-03T12:00:00Z' },
    { id: 'auto-invoice', actor: 'claude', verb: 'patch-deal-field', subject_type: 'deal', subject_id: 'd20', field: 'phase', old_value: 'Closing', new_value: 'Closed', automatic: true, change_reason: 'invoice', evidence_date: '2026-10-03', recorded_at: '2026-10-03T12:00:00Z' }];
  seed.threads.d14 = [{ id: 'demo-note', kind: 'note', actor: 'joe', at: '2026-10-01', text: 'LOI submitted. ' + 'Full original demo entry. '.repeat(30) }];
  if (many) for (let i = 20; i < 72; i++) seed.deals.push({ ...seed.deals[9], id: 'demo-' + i, name: 'Demo Assignment ' + i, phase: 'Research' });
  await page.clock.install({ time: new Date('2026-10-04T17:00:00Z') });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/data/board-seed.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(seed) });
    if (url.pathname === '/api/system-work/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ actor: { slug: 'joe' }, csrf_token: 'synthetic-only' }) });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ contentType: 'application/json', body: '{}' });
    const file = url.pathname === '/deals' ? 'pipeline.html' : url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/deals');
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.size > 0);
  return { page, errors };
}
const refresh = page => page.evaluate(async () => (await import('/js/pipeline.js')).state.boardSync.refreshBoard({ reason: 'test' }));

test('W4 desktop/phone render, owner filters, equal cards, wide detail and reduced motion', async t => {
  await mkdir(new URL('out/test-artifacts/w4/', root), { recursive: true });
  for (const width of [1440, 390, 320]) await t.test(String(width), async t => {
    const { page, errors } = await open(t, { width, reducedMotion: 'reduce' });
    assert.equal(await page.locator('#pageTitle').textContent(), 'Local Deals');
    assert.equal(await page.locator('#boardView').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.locator('#boardChips button').allTextContents(), ['All', 'Joe', 'Dell']);
    assert.equal(await page.locator('.kanban-column').count(), 8);
    assert.equal(await page.locator('.kanban-column [data-id="d06"],.kanban-column [data-id="d07"],.kanban-column [data-id="d08"]').count(), 0);
    assert.equal(await page.locator('[data-id="d01"],[data-id="d23"]').count(), 0);
    assert.equal(await page.locator('.parked-lane').evaluate(e => e.open), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const sizes = await page.locator('.kanban-column .kanban-card').evaluateAll(es => es.map(e => ({ height: e.getBoundingClientRect().height, transform: getComputedStyle(e).transform, transition: getComputedStyle(e).transitionDuration })));
    // Cards size to their content (S8): no fixed tall box with half of it empty.
    assert.ok(sizes.every(e => e.height < 212 && e.transform === 'none' && e.transition === '0s'), JSON.stringify(sizes));
    await page.screenshot({ path: new URL(`out/test-artifacts/w4/${width === 1440 ? 'desktop' : 'phone-' + width}.png`, root).pathname, fullPage: true });
    await page.locator('[data-filter="dell"]').click();
    assert.equal(await page.locator('.kanban-column .owner').evaluateAll(es => es.every(e => e.textContent === 'Dell')), true);
    await page.locator('[data-filter="all"]').click();
    await page.locator('.kanban-column [data-id="d14"]').click(); await page.waitForSelector('#detailPhase');
    const box = await page.locator('#recordPanel').boundingBox(); assert.ok(box.width >= Math.min(1100, width - 30));
    assert.ok((await page.locator('.deal-note p').first().textContent()).length <= 150);
    await page.locator('.deal-note[data-id="demo-note"] summary').click();
    assert.match(await page.locator('.deal-note[data-id="demo-note"] .note-original').textContent(), /Full original demo entry/);
    await page.locator('#recordPanel').evaluate(e => { e.scrollTop = 0; });
    assert.equal(await page.locator('#recordPanel').evaluate(e => e.scrollWidth <= e.clientWidth), true);
    await page.screenshot({ path: new URL(`out/test-artifacts/w4/detail-${width}.png`, root).pathname });
    await page.getByLabel('Close deal', { exact: true }).click(); assert.deepEqual(errors, []);
  });
});

test('touch layout scrolls into view at once, so a tap lands where it was aimed', async t => {
  for (const [width, behavior] of [[390, 'auto'], [1440, 'smooth']]) {
    const {page,errors}=await open(t,{width});
    assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).scrollBehavior),behavior,`${width}px`);
    assert.deepEqual(errors,[]);
  }
});

// A refresh that lands between a press and its drag start or click must not
// replace the pressed card, or the gesture is lost.
test('board refresh keeps a pressed card until its drag or tap completes', async t => {
  const {page,errors}=await open(t);
  const freshAction=()=>page.evaluate(async()=>{
    const {state}=await import('/js/pipeline.js');const get=state.client.getBoard;
    state.client.getBoard=async (...args)=>{
      const result=await get(...args);
      return {...result,deals:result.deals.map(d=>d.id==='d14'?{...d,next_step:'Demo fresh action during press'}:d)};
    };
  });
  await freshAction();
  for (const gesture of ['drag','tap']) {
    const card=page.locator('.kanban-column [data-id="d14"]');
    await card.evaluate(node=>{window.pressedCard=node;});
    const box=await card.boundingBox();
    await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();
    await refresh(page);
    assert.equal(await page.evaluate(()=>window.pressedCard.isConnected),true,`${gesture}: the pressed card stays`);
    if (gesture==='drag') {
      const target=await page.locator('[data-column="legal"] > h3').boundingBox();
      await page.mouse.move(target.x+10,target.y+10,{steps:5});await page.mouse.up();
      await page.waitForFunction(()=>document.querySelector('#completionDialog').open);
      await page.locator('#completionCancel').click();
    } else {
      await page.mouse.up();
      await page.waitForFunction(()=>document.querySelector('#recordPanel').open);
      await page.getByLabel('Close deal',{exact:true}).click();
    }
    await waitForAsync(page,()=>/Demo fresh action during press/.test(document.querySelector('.kanban-column [data-id="d14"]').textContent));
  }
  assert.deepEqual(errors,[]);
});

test('board refresh preserves a native drag until its drop is reviewed', async t => {
  const {page,errors}=await open(t);
  const card=page.locator('.kanban-column [data-id="d14"]');
  await card.evaluate(node=>{
    window.draggedCard=node;
    node.addEventListener('dragstart',()=>window.dragStarted=true,{once:true});
  });
  const box=await card.boundingBox();
  await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();
  await page.mouse.move(box.x+30,box.y+30,{steps:5});
  await page.waitForFunction(()=>window.dragStarted);
  await page.evaluate(async()=>{
    const {state}=await import('/js/pipeline.js');const get=state.client.getBoard;
    state.client.getBoard=async (...args)=>{
      const result=await get(...args);
      return {...result,deals:result.deals.map(d=>d.id==='d14'?{...d,next_step:'Demo fresh action during drag'}:d)};
    };
  });
  await refresh(page);
  assert.equal(await page.evaluate(()=>window.draggedCard.isConnected),true);
  assert.equal(await page.evaluate(async()=> (await import('/js/pipeline.js')).state.deals.get('d14').next_step),'Demo fresh action during drag');
  assert.doesNotMatch(await card.textContent(),/Demo fresh action during drag/);
  const target=await page.locator('[data-column="legal"] > h3').boundingBox();
  await page.mouse.move(target.x+10,target.y+10,{steps:5});await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('#completionDialog').open);
  assert.equal(await page.evaluate(async()=> (await import('/js/pipeline.js')).state.deals.get('d14').phase),'Negotiation');
  assert.match(await card.textContent(),/Demo fresh action during drag/);
  assert.deepEqual(errors,[]);
});

test('W4 drag and keyboard phase writes, manual phase, park, revive and undo record history', async t => {
  const { page, errors } = await open(t);
  await page.locator('.kanban-column [data-id="d14"] [data-undo]').click();
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').phase === 'Research');
  assert.equal(await page.locator('.kanban-column [data-id="d14"] .auto-move').count(), 0);
  assert.equal(await page.evaluate(async () => (await (await import('/js/pipeline.js')).state.client.getChanges(null)).events.filter(e => e.verb === 'revert-deal-field').length), 1);
  await page.locator('[data-id="d20"] [data-undo]').click();
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d20').phase === 'Closing');
  await page.locator('.kanban-column [data-id="d14"]').dragTo(page.locator('[data-column="legal"]'));
  await page.waitForFunction(() => document.querySelector('#completionDialog').open);
  await page.locator('#completionConfirm').click();
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').phase === 'Legal');
  await page.locator('.kanban-column [data-id="d14"]').click(); await page.waitForSelector('#detailPhase');
  await page.locator('#detailPhase').selectOption('site_selection');
  await page.locator('#completionDialog[open]').waitFor();
  assert.equal(await page.locator('#detailPhase').inputValue(), 'legal');
  await page.locator('#completionConfirm').click();
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').phase === 'Site selection');
  await page.locator('.park-options summary').click(); await page.locator('#detailParkForm input').fill('Demo unverified import'); await page.locator('#detailParkForm button').click();
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').operating_state === 'parked');
  assert.equal(await page.locator('.kanban-column [data-id="d14"]').count(), 0);
  await page.locator('#parkedToggle').click(); await page.locator('.parked-lane [data-id="d14"] [data-revive]').click();
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').operating_state === 'active');
  const revived = await page.evaluate(async () => (await (await import('/js/pipeline.js')).state.client.getChanges(null)).events.filter(e => e.field === 'operating_state').at(-1));
  assert.equal(revived.actor, 'joe'); assert.equal(revived.new_value.state, 'active');
  await page.locator('[data-id="d14"]').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); await page.locator('#completionConfirm').click();
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').phase === 'Negotiation');
  assert.deepEqual(errors, []);
});

test('W4 list attention order, whole-row detail, timed scroll and draft preservation, failure recovery', async t => {
  const { page, errors } = await open(t, { many: true });
  await page.locator('#listView').click();
  assert.equal(await page.locator('.deal-row').first().getAttribute('data-attention'), 'true');
  assert.equal(await page.locator('.parked-card').count(), 0); await page.locator('#parkedToggle').click(); assert.equal(await page.locator('.parked-card').count(), 3);
  await page.locator('#parkedToggle').click();
  await page.locator('[data-id="demo-50"]').click(); await page.waitForSelector('#detailNextForm');
  await page.locator('#detailNextForm textarea').fill('Unsaved demo next step'); await page.locator('#detailNextForm textarea').focus();
  await page.clock.fastForward(16000); assert.equal(await page.locator('#detailNextForm textarea').inputValue(), 'Unsaved demo next step');
  await page.getByLabel('Close deal', { exact: true }).click();
  await page.locator('[data-id="demo-50"]').focus(); await page.evaluate(() => scrollBy(0, 350)); const before = await page.evaluate(() => scrollY);
  await refresh(page); assert.equal(await page.evaluate(() => scrollY), before);
  await page.clock.fastForward(16000); assert.equal(await page.evaluate(() => scrollY), before);
  await page.evaluate(async () => { const { state } = await import('/js/pipeline.js'); const get = state.client.getBoard; let fail = true; state.client.getBoard = async (...a) => { if (fail) { fail = false; throw new Error('synthetic outage'); } return get(...a); }; });
  await refresh(page); await page.clock.fastForward(16000);
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.boardSync.status().state === 'ready');
  assert.deepEqual(errors, []);
});


test('W4 lost park response retries the original field exactly once; next-step edits are separate actions', async t => {
  const { page, errors } = await open(t);
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const original = state.client.patchDealField; let lose = true;
    state.client.patchDealField = async request => {
      const result = await original(request);
      if (request.field === 'operating_state' && lose) { lose = false; throw new Error('synthetic lost reply'); }
      return result;
    };
  });
  await page.locator('[data-id="d14"] .card-open').click();
  await page.locator('.park-options summary').click();
  await page.locator('#detailParkForm input').fill('Demo duplicate import');
  await page.locator('#detailParkForm button').click();
  await page.getByLabel('Close deal', { exact: true }).click();
  await page.locator('[data-retry-write]').click();
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').operating_state === 'parked');
  const changes = await page.evaluate(async () => (await (await import('/js/pipeline.js')).state.client.getChanges(null)).events);
  assert.equal(changes.filter(e => e.field === 'operating_state' && e.subject_id === 'd14').length, 1);
  assert.equal(changes.filter(e => e.field === 'phase' && e.subject_id === 'd14').length, 1);
  await page.locator('#parkedToggle').click(); await page.locator('.parked-lane [data-id="d14"] [data-revive]').click();
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').operating_state === 'active');
  await page.locator('[data-id="d14"] .card-open').click();
  for (const text of ['Demo first next step', 'Demo second next step']) {
    await page.locator('#detailNextForm textarea').fill(text); await page.locator('#detailNextForm button').click();
    await page.waitForFunction(expected => document.querySelector('.detail-next').textContent === expected, text);
  }
  assert.deepEqual(errors, []);
});

test('W4 detail polls phase evidence, dates, people and parking while preserving drafts and expanded originals', async t => {
  const { page, errors } = await open(t);
  await page.locator('[data-id="d14"] .card-open').click();
  await page.locator('.deal-note[data-id="demo-note"] summary').click();
  await page.locator('#detailNextForm textarea').fill('Demo unsaved draft');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js'); const original = state.client.getDeal;
    state.client.getDeal = async id => {
      const detail = await original(id);
      return { ...detail, deal: { ...detail.deal, phase: 'Legal', operating_state: 'parked', parking_note: 'Demo reviewed import', phase_change: {event_id:'demo-auto',prior_phase:'Negotiation',automatic:true,reason:'Draft prepared',evidence_date:'2026-10-04'} }, critical_dates:[{label:'Demo deadline',date:'2026-10-09'}],participants:[{name:'Demo advisor'}],activities:[{id:'demo-meeting',kind:'meeting',source:'synthetic calendar',summary:'Demo scheduled tour',occurred_at:'2026-10-05T17:00:00Z'}] };
    };
  });
  await page.clock.fastForward(16000);
  await page.waitForFunction(() => document.querySelector('[data-detail-read="parking"]')?.textContent.includes('Demo reviewed import'));
  assert.equal(await page.locator('#detailPhase').inputValue(), 'legal');
  assert.match(await page.locator('.phase-rail [aria-current]').textContent(), /Legal/);
  assert.match(await page.locator('[data-detail-read="automatic"]').textContent(), /Draft prepared 10\/4/);
  assert.match(await page.locator('[data-detail-read="dates"]').textContent(), /Demo deadline/);
  assert.match(await page.locator('[data-detail-read="people"]').textContent(), /Demo advisor/);
  await page.waitForFunction(() => document.querySelector('#panelEvidence')?.textContent.includes('Demo scheduled tour'));
  assert.equal(await page.locator('#detailNextForm textarea').inputValue(), 'Demo unsaved draft');
  assert.equal(await page.locator('.deal-note[data-id="demo-note"] details').evaluate(e => e.open), true);
  assert.deepEqual(errors, []);
});


test('W4 a long automatic reason keeps its date and Undo visible inside the fixed-size card', async t => {
  const { page } = await open(t);
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js'); const original = state.client.getBoard;
    state.client.getBoard = async (...args) => {
      const board = await original(...args);
      board.deals.find(d => d.id === 'd14').phase_change.reason = 'Demo submitted letter of intent with updated negotiated terms';
      return board;
    };
  });
  await refresh(page);
  const card = page.locator('[data-id="d14"]');
  const date = card.locator('.auto-move time');
  assert.equal(await date.textContent(), '10/3');
  const outer = await card.boundingBox(), stamp = await date.boundingBox(), undo = await card.locator('[data-undo]').boundingBox();
  assert.ok(stamp.y >= outer.y && stamp.y + stamp.height <= outer.y + outer.height);
  assert.ok(undo.y + undo.height <= outer.y + outer.height);
  // V2 hover is a hairline step on the border, not a lift (no hover transforms).
  const restingBorder = await card.evaluate(e => getComputedStyle(e).borderRightColor);
  await card.hover();
  await page.waitForFunction(resting => getComputedStyle(document.querySelector('[data-id="d14"]')).borderRightColor !== resting, restingBorder);
  // Attention reads in words with a glyph, never a bare colour dot (S8).
  assert.equal(await page.locator('[data-id="d20"] .attention-flag').textContent(), '◆ Needs you');
});


test('W4 detail and next-step rereads time out at the client seam and recover without losing a draft', async t => {
  const { page, errors } = await open(t);
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const read = state.client.getDeal;
    window.detailProbe = { calls: 0, hang: true, release: null };
    state.client.getDeal = async (...args) => {
      window.detailProbe.calls++;
      if (window.detailProbe.hang) return new Promise(resolve => { window.detailProbe.release = async () => resolve(await read(...args)); });
      return read(...args);
    };
  });
  await page.locator('.kanban-column [data-id="d14"] .card-open').click();
  await page.waitForFunction(() => window.detailProbe.calls > 0);
  await page.clock.runFor(10_001);
  await page.getByText('Updates temporarily unavailable', {exact:true}).waitFor();
  assert.equal(await page.locator('[data-retry-detail]').count(),0);
  await page.evaluate(() => { window.detailProbe.hang = false; });
  await page.clock.fastForward(16000);
  await page.locator('#detailNextForm').waitFor();
  await page.locator('#detailNextForm textarea').fill('Unsaved deadline demo');
  await page.evaluate(() => { window.detailProbe.hang = true; window.detailProbe.calls = 0; });
  await page.locator('#detailNextForm button').click();
  await page.waitForFunction(() => window.detailProbe.calls > 0);
  await page.clock.runFor(10_001);
  await page.waitForFunction(() => document.querySelector('#detailNextStatus').textContent.includes('is updating'));
  assert.equal(await page.locator('#detailNextForm textarea').isEnabled(), true);
  assert.equal(await page.locator('#detailNextForm textarea').inputValue(), 'Unsaved deadline demo');
  await page.evaluate(() => { window.detailProbe.hang = false; });
  await page.locator('#detailNextForm button').click();
  await page.waitForFunction(() => document.querySelector('#detailNextStatus').textContent === 'Next step confirmed');
  await page.evaluate(() => window.detailProbe.release());
  assert.equal(await page.locator('#detailNextForm textarea').inputValue(), 'Unsaved deadline demo');
  assert.deepEqual(errors, []);
});

test('S8 the move toast never covers the Today column or the status band', async t => {
  for (const width of [1440, 1000, 390]) await t.test(String(width), async t => {
    const { page } = await open(t, { width });
    const overlap = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const rects = () => page.evaluate(() => {
      document.querySelectorAll('.toast').forEach(node => node.remove());
      const toast = document.createElement('div'); toast.className = 'toast show'; toast.textContent = 'Moved Demo deal to Negotiation'; document.body.append(toast);
      const box = node => { if (!node) return null; const r = node.getBoundingClientRect(); return r.width && r.height && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none' ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null; };
      return { toast: box(toast), today: box(document.querySelector('#appToday')), status: box(document.querySelector('.app-layout-status')) };
    });
    if (width === 390) { await page.locator('#appTodayToggle').click(); await page.locator('#appToday').evaluate(n => n.getAnimations().forEach(a => a.finish())); }
    let r = await rects();
    if (width === 390) assert.ok(r.today?.left < 390, 'Today is open in the viewport');
    if (width !== 390) assert.ok(r.toast, 'toast renders');
    assert.equal(overlap(r.toast, r.today), false, `${width}: toast clears Today`);
    assert.equal(overlap(r.toast, r.status), false, `${width}: toast clears the status band`);
    if (width === 1440) {
      await page.locator('#appTodayToggle').click();
      r = await rects();
      assert.ok(r.toast.right > 1440 - 120, 'with Today closed the toast returns to the right edge');
    }
  });
});

test('S8 phone status strip scrolls inside its own lane, never under the workspace controls or Doc', async t => {
  const { page } = await open(t, { width: 390 });
  const lanes = await page.evaluate(() => {
    const status = document.querySelector('.app-layout-status');
    const r = status.getBoundingClientRect(), s = getComputedStyle(status);
    const clipRight = r.right - parseFloat(s.borderRightWidth);
    const blockers = [...document.querySelectorAll('.app-shell-controls, #docPresence')]
      .map(node => node.getBoundingClientRect()).filter(box => box.width && box.top < r.bottom && box.bottom > r.top);
    return { clipRight, blockerLeft: Math.min(...blockers.map(box => box.left)) };
  });
  assert.ok(lanes.clipRight <= lanes.blockerLeft + 1, `status clips at ${lanes.clipRight}, controls start at ${lanes.blockerLeft}`);
});

for (const theme of ['dark', 'light']) {
  const movePhoneDeal = async page => {
    await page.locator('#appTodayToggle').evaluate(node => {
      if (node.getAttribute('aria-expanded') === 'true') node.click();
    });
    const card = page.locator('.kanban-column [data-id="d14"]');
    await card.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.locator('#completionConfirm').click();
    await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').phase === 'Legal');
  };

  test(`phone ${theme} move toast Undo restores the exact move once`, async t => {
    const { page, errors } = await open(t, { width: 390, height: 844, reducedMotion: 'reduce' });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await movePhoneDeal(page);
    const undo = page.locator('.toast button[data-undo]');
    assert.equal(await undo.count(), 1, 'move toast offers Undo');
    const eventId = await undo.getAttribute('data-undo');
    await mkdir(new URL('out/test-artifacts/share-followup/', root), { recursive: true });
    await page.screenshot({ path: new URL(`out/test-artifacts/share-followup/toast-390-${theme}.png`, root).pathname });
    await undo.click();
    await page.clock.runFor(5001);
    assert.equal(await page.locator(`#receiptsList [data-receipt="${eventId}"]`).count(), 1, 'Today and toast target the same event');
    await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').phase === 'Negotiation');
    const reverted = await page.evaluate(async () => (await (await import('/js/pipeline.js')).state.client.getChanges(null)).events.filter(event => event.verb === 'revert-deal-field'));
    assert.equal(reverted.length, 1);
    await refresh(page);
    await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').phase === 'Negotiation');
    assert.deepEqual(errors, []);
  });

  test(`phone ${theme} Today hides floating feedback and contains receipt text`, async t => {
    const { page, errors } = await open(t, { width: 390, height: 844, reducedMotion: 'reduce' });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await movePhoneDeal(page);
    await page.clock.runFor(1401);
    await page.locator('#appTodayToggle').click();
    assert.equal(await page.locator('.toast').count(), 1);
    assert.equal(await page.locator('.toast').isVisible(), false);
    assert.equal(await page.locator('.receipt-dock').isVisible(), false, 'floating command receipt cannot cover Today');
    await page.locator('#receiptsList [data-undo]').first().click();
    await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').phase === 'Negotiation');
    await page.clock.runFor(1401);
    const clipping = await page.locator('#receiptsList .receipt').evaluateAll(rows => rows.flatMap(row => {
      const bounds = row.getBoundingClientRect();
      return [...row.querySelectorAll('.receipt-line, .receipt-meta, .receipt-actions, .receipt-message, .receipt-badge, .receipt-deal')]
        .filter(node => node.getBoundingClientRect().right > bounds.right + 1 || node.scrollWidth > node.clientWidth + 1)
        .map(node => node.className);
    }));
    assert.deepEqual(clipping, [], 'all receipt text and status fit inside the card');
    await mkdir(new URL('out/test-artifacts/share-followup/', root), { recursive: true });
    await page.screenshot({ path: new URL(`out/test-artifacts/share-followup/today-390-${theme}.png`, root).pathname });
    assert.deepEqual(errors, []);
  });
}
