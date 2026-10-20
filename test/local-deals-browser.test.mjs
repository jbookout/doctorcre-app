import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, waitForAsync } from './browser-harness.mjs';
const root = new URL('../', import.meta.url);
const phases = ['On Deck', 'Research', 'Site selection', 'Negotiation', 'Legal', 'Diligence', 'Closing', 'Closed'];
async function open(t, { width = 1440, height = 960, reducedMotion = 'no-preference', many = false, review = false, deal = null } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const seed = JSON.parse(await readFile(new URL('data/board-seed.json', root), 'utf8'));
  seed.deals.forEach((d, i) => Object.assign(d, { phase: phases[i % 8], next_step: 'Confirm the next appointment', last_touch: '2026-10-01', last_review_at: '2026-10-01T16:00:00Z', next_date: null, attention: false }));
  Object.assign(seed.deals.find(d => d.id === 'd14'), {phase:'Negotiation',next_date:'2026-10-02'});
  Object.assign(seed.deals.find(d => d.id === 'd20'),{phase:'Closed',outcome:'won'});
  Object.assign(seed.deals.find(d => d.id === 'd23'),{invoiced_on:'2026-10-01',phase:'Closed',closed_on:'2026-10-02',type:'Renewal',client_name:'Demo Archive Client'});
  seed.seed_events = [{ id: 'auto-loi', actor: 'claude', verb: 'patch-deal-field', subject_type: 'deal', subject_id: 'd14', field: 'phase', old_value: 'Research', new_value: 'Negotiation', automatic: true, change_reason: 'LOI sent', evidence_date: '2026-10-03', recorded_at: '2026-10-03T12:00:00Z' },
    { id: 'auto-invoice', actor: 'claude', verb: 'patch-deal-field', subject_type: 'deal', subject_id: 'd20', field: 'phase', old_value: 'Closing', new_value: 'Closed', automatic: true, change_reason: 'invoice', evidence_date: '2026-10-03', recorded_at: '2026-10-03T12:00:00Z' }];
  seed.threads.d14 = [{ id: 'demo-note', kind: 'note', actor: 'joe', at: '2026-10-01', text: 'LOI submitted. ' + 'Full original demo entry. '.repeat(30) }];
  if (many) for (let i = 20; i < 72; i++) seed.deals.push({ ...seed.deals[9], id: 'demo-' + i, name: 'Demo Assignment ' + i, phase: 'Research', outcome:null });
  if (review) for (let i=0;i<28;i++) seed.deals.push({...seed.deals.find(d=>d.id==='d14'),id:`demo-review-${i}`,name:`Demo Practice ${i+1}`,client_name:`Demo Client ${i+1}`,type:'Renewal',phase:phases[i%7],owner:i%2?'dell':'joe',workspace_kind:'team',account_client_id:null,operating_state:'active'});
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
  await page.goto('http://localhost/deals' + (deal ? '?deal='+encodeURIComponent(deal) : ''));
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.size > 0);
  return { page, errors, seed };
}
const refresh = page => page.evaluate(async () => (await import('/js/pipeline.js')).state.boardSync.refreshBoard({ reason: 'test' }));

test('W4 desktop/phone render, owner filters, equal cards, wide detail and reduced motion', async t => {
  await mkdir(new URL('out/test-artifacts/w4/', root), { recursive: true });
  for (const width of [1440, 390, 320]) await t.test(String(width), async t => {
    const { page, errors } = await open(t, { width, reducedMotion: 'reduce' });
    assert.equal(await page.locator('#pageTitle').textContent(), 'Local Deals');
    assert.equal(await page.locator('#boardView').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.locator('#boardChips button').allTextContents(), ['All', 'Joe', 'Dell']);
    assert.equal(await page.locator('.kanban-column').count(), 7);
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
    await page.locator('.updates-history > summary').click();
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
  assert.equal(await page.locator('.parked-card').count(), 0); await page.locator('#parkedToggle').click(); assert.equal(await page.locator('.parked-card').count(), 2);
  await page.locator('#parkedToggle').click();
  await page.locator('[data-id="demo-50"]').click(); await page.waitForSelector('#detailUpdateForm');
  await page.locator('#detailUpdateForm textarea').fill('Unsaved demo next step'); await page.locator('#detailUpdateForm textarea').focus();
  await page.clock.fastForward(16000); assert.equal(await page.locator('#detailUpdateForm textarea').inputValue(), 'Unsaved demo next step');
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
    await page.locator('#detailUpdateForm textarea').fill(text); await page.locator('#detailUpdateForm button').click();
    await page.waitForFunction(expected => document.querySelector('.deal-updates').textContent.includes(expected), text);
  }
  assert.deepEqual(errors, []);
});

test('W4 detail polls phase evidence, dates, people and parking while preserving drafts and expanded originals', async t => {
  const { page, errors } = await open(t);
  await page.locator('[data-id="d14"] .card-open').click();
  await page.locator('.updates-history > summary').click();
    await page.locator('.deal-note[data-id="demo-note"] summary').click();
  await page.locator('#detailUpdateForm textarea').fill('Demo unsaved draft');
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

  assert.equal(await page.locator('[data-detail-read="dates"]').count(),0);

  assert.match(await page.locator('.deal-updates').textContent(),/Demo scheduled tour/);
  assert.equal(await page.locator('#detailUpdateForm textarea').inputValue(), 'Demo unsaved draft');
  assert.equal(await page.locator('.deal-note[data-id="demo-note"] details').evaluate(e => e.open), true);
  assert.deepEqual(errors, []);
});


test('W4 a long automatic reason keeps its date visible without persistent card controls', async t => {
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
  const outer = await card.boundingBox(), stamp = await date.boundingBox();
  assert.ok(stamp.y >= outer.y && stamp.y + stamp.height <= outer.y + outer.height);
  assert.equal(await card.locator('[data-undo]').count(), 0);
  // V2 hover is a hairline step on the border, not a lift (no hover transforms).
  const restingBorder = await card.evaluate(e => getComputedStyle(e).borderRightColor);
  await card.hover();
  await page.waitForFunction(resting => getComputedStyle(document.querySelector('[data-id="d14"]')).borderRightColor !== resting, restingBorder);
  // Attention reads in words with a glyph, never a bare colour dot (S8).
  assert.equal(await page.locator('[data-id="d14"] .attention-flag').textContent(), '◆ Overdue');
});


test('detail reads recover without losing an update draft', async t => {
 const {page,errors}=await open(t);
 await page.locator('[data-id="d14"] .card-open').click();
 await page.locator('#detailUpdateForm textarea').fill('Unsaved demo update');
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');const read=state.client.getDeal;window.restoreRead=()=>state.client.getDeal=read;state.client.getDeal=async()=>{throw Error('Synthetic outage');};});
 await page.clock.fastForward(16000);
 await page.getByText('Updates temporarily unavailable',{exact:true}).waitFor();
 assert.equal(await page.locator('#detailUpdateForm textarea').inputValue(),'Unsaved demo update');
 await page.evaluate(()=>restoreRead());await page.clock.fastForward(16000);
 await page.locator('#detailUpdateForm button').click();
 await page.waitForFunction(()=>document.querySelector('.deal-updates').textContent.includes('Unsaved demo update'));
 assert.equal(await page.locator('#detailUpdateForm textarea').inputValue(),'');
 assert.deepEqual(errors,[]);
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
    await page.locator('#appTodayToggle').click();
    await page.locator('#appToday').evaluate(n => n.getAnimations().forEach(a => a.finish()));
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
  const moveDeal = async page => {
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

  for (const width of [390, 1440]) test(`${width} ${theme} move feedback uses one Undo surface`, async t => {
    const { page, errors } = await open(t, { width, height: 844 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await moveDeal(page);
    for (const advance of [350, 1400]) {
      await page.clock.runFor(advance);
      assert.equal(await page.locator('.toast').isVisible(), true);
      const boxes = await page.evaluate(() => {
        const toast = document.querySelector('.toast').getBoundingClientRect();
        const dock = document.querySelector('.receipt-dock').getBoundingClientRect();
        return { dockArea: dock.width * dock.height,
          overlap: Math.max(0, Math.min(toast.right, dock.right) - Math.max(toast.left, dock.left)) *
            Math.max(0, Math.min(toast.bottom, dock.bottom) - Math.max(toast.top, dock.top)) };
      });
      assert.equal(boxes.overlap, 0, 'toast and command receipt never overlap');
      assert.equal(boxes.dockArea, 0, 'move feedback uses only the Undo toast during its lifetime');
      assert.equal(await page.locator('.toast:visible, .receipt-dock:visible').count(), 1, 'exactly one move feedback surface is visible');
    }
    await mkdir(new URL('out/test-artifacts/share-followup/', root), { recursive: true });
    await page.screenshot({ path: new URL(`out/test-artifacts/share-followup/feedback-${width}-${theme}.png`, root).pathname });
    await page.clock.runFor(4101);
    assert.equal(await page.locator('.toast').count(), 0);
    assert.equal(await page.locator('.receipt-dock .receipt').count(), 0, 'success feedback leaves no permanent receipt');
    assert.deepEqual(errors, []);
  });

  for (const width of [390, 1440]) test(`${width} ${theme} move toast Undo restores the exact move once`, async t => {
    const { page, errors } = await open(t, { width, height: 844, reducedMotion: 'reduce' });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await moveDeal(page);
    const undo = page.locator('.toast button[data-undo]');
    assert.equal(await undo.count(), 1, 'move toast offers Undo');
    const eventId = await undo.getAttribute('data-undo');
    await mkdir(new URL('out/test-artifacts/share-followup/', root), { recursive: true });
    await page.screenshot({ path: new URL(`out/test-artifacts/share-followup/toast-${width}-${theme}.png`, root).pathname });
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
    await moveDeal(page);
    await page.clock.runFor(1401);
    await page.locator('#appTodayToggle').click();
    assert.equal(await page.locator('.toast').count(), 1);
    assert.equal(await page.locator('.toast').isVisible(), false);
    assert.equal(await page.locator('.receipt-dock').isVisible(), false, 'floating command receipt cannot cover Today');
    assert.equal(await page.locator('#receiptsList [data-undo]').count(), 0, 'Today history has no persistent Undo');
    await page.getByRole('button', {name:'Close Today',exact:true}).click();
    await page.locator('.toast [data-undo]').click();
    await page.locator('#appTodayToggle').click();
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


test('deal review keeps closed deals off the board and searches invoiced history', async t => {
 const {page,errors}=await open(t,{width:1280});
 assert.equal(await page.locator('#boardLive').textContent(),'1 open deals · 2 parked');
 assert.equal(await page.locator('[data-column="closed"]').count(),0);
 assert.equal(await page.locator('#kanban [data-id="d20"]').count(),0);
 await page.getByRole('button',{name:'Closed deals',exact:true}).click();
 assert.match(await page.locator('#closedDealsList').textContent(),/Demo/);
 const closed=page.locator('#closedDealsList [data-id="d20"]');
 assert.equal(await closed.count(),1);
 assert.match(await closed.textContent(),/Client|Demo/);
 await page.getByLabel('Search closed deals').fill('Demo Archive Client');
 assert.equal(await page.locator('#closedDealsList [data-id="d23"]').count(),1);
 assert.match(await page.locator('#closedDealsList').textContent(),/Renewal/);
 await page.getByLabel('Search closed deals').fill('2026-10-02');
 assert.equal(await page.locator('#closedDealsList [data-id="d23"]').count(),1);
 await page.getByLabel('Search closed deals').fill('no matching demo deal');
 assert.match(await page.locator('#closedDealsList').textContent(),/No closed deals/);
 await page.getByLabel('Search closed deals').fill('');
 await page.getByRole('button',{name:'Board',exact:true}).click();
 assert.equal(await page.locator('.kanban-column').count(),7);
 assert.deepEqual(errors,[]);
});


test('add deal validates input, retains an uncertain request and immediately shows the selected owner card', async t => {
 const {page,errors}=await open(t,{width:390});
 assert.equal(await page.getByRole('button',{name:'Add deal',exact:true}).count(),1);
 await page.evaluate(async()=>{
  const {state}=await import('/js/pipeline.js');const create=state.client.createDeal.bind(state.client);window.createRequests=[];
  state.client.createDeal=async args=>{window.createRequests.push({...args});const result=await create(args);if(window.createRequests.length===1)throw new Error('Lost receipt');return result;};
 });
 await page.getByRole('button',{name:'Add deal',exact:true}).focus();await page.keyboard.press('Enter');
 await page.getByLabel('Deal name',{exact:true}).fill('  ');
 await page.getByLabel('Client',{exact:true}).fill('C-demo');
 await page.getByRole('button',{name:'Create deal',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.createRequests.length),0);
 await page.getByLabel('Deal name',{exact:true}).fill('Demo Partner Review');
 await page.getByLabel('Owner',{exact:true}).selectOption('dell');
 await page.getByLabel('Type',{exact:true}).selectOption('renewal');
 await page.getByLabel('Stage',{exact:true}).selectOption('Research');
 await page.getByLabel('Notes',{exact:true}).fill('Demo initial review note');
 await page.getByRole('button',{name:'Create deal',exact:true}).click();
 await waitForAsync(page,()=>document.querySelector('#addDealError').textContent.includes('not confirmed'));
 assert.equal(await page.getByLabel('Deal name',{exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Add deal',exact:true}).click();
 await page.getByRole('button',{name:'Check creation outcome',exact:true}).click();
 await waitForAsync(page,()=>!document.querySelector('#addDealDialog').open);
 const requests=await page.evaluate(()=>window.createRequests);assert.deepEqual(requests[0],requests[1]);
 assert.equal(requests[0].owner,'dell');assert.equal(requests[0].notes,'Demo initial review note');
 const cards=page.locator('.kanban-column .kanban-card').filter({hasText:'Demo Partner Review'});assert.equal(await cards.count(),1);
 assert.match(await cards.textContent(),/Dell/);
 assert.equal(await page.evaluate(()=>new URL(location.href).searchParams.get('owner')),'dell');
 await cards.getByRole('button',{name:'Demo Partner Review'}).click();
 await page.waitForSelector('#detailPhase');assert.match(await page.locator('#panelBody').textContent(),/Demo initial review note/);
 assert.deepEqual(errors,[]);
});


test('deal review works in both themes at 390 and 1280 pixels', async t => {
 await mkdir(new URL('out/test-artifacts/dealroom-review/',root),{recursive:true});
 for (const width of [390,1280]) for (const theme of ['light','dark']) await t.test(`${width} ${theme}`,async t=>{
  const {page,errors}=await open(t,{width,review:true});
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.locator('.kanban-column').count(),7);
  const widths=await page.locator('.kanban-card').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().width));
  assert.ok(widths.every(w=>w>=130),JSON.stringify(widths));
  const shot=name=>page.screenshot({path:new URL(`out/test-artifacts/dealroom-review/${width}-${theme}-${name}.png`,root).pathname,animations:'disabled'});
  await shot('board');
  await page.getByRole('button',{name:'Parked',exact:true}).click();
  assert.equal(await page.locator('.parked-lane').evaluate(e=>e.open),true);
  await page.getByRole('button',{name:'Closed deals',exact:true}).click();await shot('closed');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole('button',{name:'Add deal',exact:true}).click();
  assert.equal(await page.locator('#addDealDialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  await shot('add');await page.keyboard.press('Escape');
  assert.equal(await page.locator('#addDealOpen').evaluate(e=>e===document.activeElement),true);
  assert.deepEqual(errors,[]);
 });
});


test('closing a deal from its details removes the card and retains its close date in history', async t=>{
 const {page,errors}=await open(t);
 await page.locator('.kanban-column [data-id="d14"] .card-open').click();await page.waitForSelector('#detailPhase');
 await page.locator('#detailPhase').selectOption('closed');
 await page.getByLabel('Won',{exact:true}).check();
 await page.locator('#completionClosedOn').fill('2026-10-04');
 await page.locator('#completionConfirm').click();
 await waitForAsync(page,()=>!document.querySelector('#completionDialog').open);
 await page.getByLabel('Close deal',{exact:true}).click();
 assert.equal(await page.locator('#kanban [data-id="d14"]').count(),0);
 await page.getByRole('button',{name:'Closed deals',exact:true}).click();
 assert.match(await page.locator('#closedDealsList [data-id="d14"]').textContent(),/Oct 4, 2026/);
 assert.deepEqual(errors,[]);
});

test('a refused client stays editable with a clear error and a fresh creation key', async t=>{
 const {page,errors}=await open(t);
 await page.evaluate(async()=>{
  const {state}=await import('/js/pipeline.js');const create=state.client.createDeal.bind(state.client);window.createKeys=[];
  state.client.createDeal=async args=>{window.createKeys.push(args.idempotency_key);if(window.createKeys.length===1)throw Object.assign(new Error('Refused'),{creationRefused:true,payload:{error:'subject_not_found'}});return create(args);};
 });
 await page.getByRole('button',{name:'Add deal',exact:true}).click();
 await page.getByLabel('Deal name',{exact:true}).fill('Demo Corrected Deal');
 await page.getByLabel('Client',{exact:true}).fill('Unknown demo');
 await page.getByRole('button',{name:'Create deal',exact:true}).click();
 await waitForAsync(page,()=>document.querySelector('#addDealError').textContent.includes('Client not found'));
 assert.equal(await page.getByLabel('Client',{exact:true}).isEnabled(),true);
 await page.getByLabel('Client',{exact:true}).fill('C-demo');
 await page.getByRole('button',{name:'Create deal',exact:true}).click();
 await waitForAsync(page,()=>!document.querySelector('#addDealDialog').open);
 const keys=await page.evaluate(()=>window.createKeys);assert.notEqual(keys[0],keys[1]);
 assert.deepEqual(errors,[]);
});


test('failed board reads remain unavailable after local view repaints',async t=>{
 const {page,errors}=await open(t);
 await page.evaluate(async()=>{
  const {state}=await import('/js/pipeline.js');
  state.client.getBoard=async()=>{throw Object.assign(new Error('Synthetic read refused'),{status:503});};
  await state.boardSync.refreshBoard({reason:'failed-read-regression'});
 });
 await waitForAsync(page,async()=>(await import('/js/pipeline.js')).state.boardSync.stats().board_failed>0);
 await page.locator('#listView').click();
 assert.match(await page.locator('#boardLive').textContent(),/could not be read|unavailable/i);
 assert.match(await page.locator('#boardAsOf').textContent(),/unavailable/i);
 assert.deepEqual(errors,[]);
});


test('a move offers Undo only in its temporary toast, never on cards after reload', async t => {
  const {page, errors, seed} = await open(t);
  await page.locator('.kanban-column [data-id="d14"] .card-open').click();
  await page.locator('#detailPhase').selectOption('legal');
  await page.locator('#completionConfirm').click();
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').phase === 'Legal');
  await page.getByLabel('Close deal', {exact:true}).click();
  assert.equal(await page.locator('.toast [data-undo]').count(), 1);
  const saved = await page.evaluate(async () => {
    const {state} = await import('/js/pipeline.js');
    return {deal: (await state.client.getBoard()).deals.find(d => d.id === 'd14'),
      events: (await state.client.getChanges(null)).events};
  });
  Object.assign(seed.deals.find(d => d.id === 'd14'), saved.deal);
  seed.seed_events = saved.events;
  await page.reload();
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.size > 0);
  assert.equal(await page.locator('[data-id="d14"] [data-undo]').count(), 0, 'the moved card has no Undo after reload');
  await page.getByRole('button', {name:'Closed deals', exact:true}).click();
  await page.locator('[data-id="d20"]').waitFor();
  assert.equal(await page.locator('[data-id="d20"] [data-undo]').count(), 0, 'persisted automatic move history never restores card Undo');
  assert.equal(await page.locator('.toast [data-undo]').count(), 0, 'reload never restores an Undo toast');
  assert.deepEqual(errors, []);
});

test('move Undo uses the same two-second success hold and fade, without permanent notifications', async t => {
  const {page, errors} = await open(t);
  await page.locator('.kanban-column [data-id="d14"] .card-open').click();
  await page.locator('#detailPhase').selectOption('legal');
  await page.locator('#completionConfirm').click();
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').phase === 'Legal');
  await page.getByLabel('Close deal', {exact:true}).click();
  await page.clock.runFor(1900);
  assert.equal(await page.locator('.toast [data-undo]').count(), 1, 'Undo remains available during the success hold');
  await page.clock.runFor(1000);
  assert.equal(await page.locator('.toast').count(), 0, 'the expired Undo toast leaves the DOM');
  assert.equal(await page.locator('#receiptDock .receipt').count(), 0, 'a confirmed move leaves no permanent bottom notification');
  assert.equal(await page.locator('[data-undo]').count(), 0, 'history is not another Undo surface');
  assert.deepEqual(errors, []);
});


test('successful deal updates disappear from the DOM within three seconds in both motion modes', async t => {
  for (const reducedMotion of ['no-preference', 'reduce']) await t.test(reducedMotion, async t => {
    const {page, errors} = await open(t, {reducedMotion});
    await page.locator('.kanban-column [data-id="d14"] .card-open').click();
    await page.locator('.park-options summary').click();
    await page.locator('#detailParkForm input').fill('Demo review later');
    await page.locator('#detailParkForm button').click();
    await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.get('d14').operating_state === 'parked');
    assert.equal(await page.locator('.toast').textContent(), 'Deal parked');
    await page.clock.runFor(1900);
    assert.equal(await page.locator('.toast').isVisible(), true);
    await page.clock.runFor(1000);
    assert.equal(await page.locator('.toast').count(), 0);
    assert.equal(await page.locator('#receiptDock .receipt').count(), 0);
    assert.deepEqual(errors, []);
  });
});

for (const width of [390,1280]) test(`move follow-ups preserve the original Undo event and expiry at ${width}px`, async t => {
  const {page, errors} = await open(t, {width, reducedMotion:'reduce'});
  await page.evaluate(async () => {
    const {state} = await import('/js/pipeline.js');
    const add = state.client.addDealNote.bind(state.client);
    state.client.addDealNote = args => new Promise(resolve => { window.finishEvidence = async () => resolve(await add(args)); });
  });
  const card = page.locator('.kanban-column [data-id="d14"]');
  await card.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  await page.locator('#completionEvidence').fill('Demo lease evidence');
  await page.locator('#completionNextStep').fill('Confirm demo appointment');
  await page.locator('#completionConfirm').click();
  await waitForAsync(page, () => typeof window.finishEvidence === 'function');
  const eventId = await page.locator('.toast [data-undo]').getAttribute('data-undo');
  await page.clock.runFor(1000);
  await page.evaluate(() => window.finishEvidence());
  await page.locator('#completionDialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('.toast [data-undo]').count(),1,'evidence and next-step confirmations preserve move Undo');
  assert.equal(await page.locator('.toast [data-undo]').getAttribute('data-undo'),eventId);
  await page.clock.runFor(1001);
  assert.equal(await page.locator('.toast').evaluate(n=>n.classList.contains('is-leaving')),true,'follow-ups never restart the original two-second hold');
  assert.equal(await page.locator('.toast [data-undo]').isEnabled(),true,'Undo remains usable through the fade');
  await page.clock.runFor(800);
  assert.equal(await page.locator('.toast').count(),0);
  assert.deepEqual(errors,[]);
});

for (const width of [390,1280]) for (const input of ['pointer','keyboard']) test(`phase-picker Undo works inside the open modal with ${input} at ${width}px`, async t => {
  const {page, errors} = await open(t, {width, reducedMotion:'reduce'});
  await page.locator('.kanban-column [data-id="d14"] .card-open').click();
  await page.locator('#detailPhase').selectOption('legal');
  await page.locator('#completionConfirm').click();
  await page.locator('#completionDialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#recordPanel').evaluate(n=>n.open),true);
  const undo = page.locator('.toast [data-undo]');
  if (input === 'pointer') await undo.click({timeout:1500});
  else {
    await page.locator('#panelClose').focus();
    for (let i=0; i<4 && !await undo.evaluate(n=>n===document.activeElement); i++) await page.keyboard.press('Shift+Tab');
    assert.equal(await undo.evaluate(n=>n===document.activeElement),true,'Undo is reachable through the modal tab order');
    await page.keyboard.press('Enter');
  }
  await waitForAsync(page,async ()=>(await import('/js/pipeline.js')).state.deals.get('d14').phase==='Negotiation');
  assert.equal(await page.locator('#recordPanel').evaluate(n=>n.open),true);
  assert.equal(await page.locator('.toast [data-undo]').count(),0);
  assert.deepEqual(errors,[]);
});

for (const width of [390,1280]) test(`Undo follows modal open and close without renewing its deadline at ${width}px`, async t => {
  const {page, errors} = await open(t, {width, reducedMotion:'reduce'});
  await page.locator('.kanban-column [data-id="d14"] .card-open').click();
  await page.locator('#detailPhase').selectOption('legal');
  await page.locator('#completionConfirm').click();
  await page.locator('#completionDialog').waitFor({state:'hidden'});
  await waitForAsync(page, () => document.querySelector('.toast')?.parentElement.id === 'recordPanel');
  await page.evaluate(() => { window.moveToast = document.querySelector('.toast'); });
  await page.clock.runFor(500);
  await page.locator('#panelClose').click();
  await waitForAsync(page, () => document.querySelector('.toast')?.parentElement === document.body);
  assert.equal(await page.locator('.toast').isVisible(),true);
  await page.locator('.kanban-column [data-id="d14"] .card-open').click();
  await waitForAsync(page, () => document.querySelector('.toast')?.parentElement.id === 'recordPanel');
  assert.equal(await page.locator('.toast').evaluate(n=>n === window.moveToast),true,'modal handoffs keep the original toast node');
  await page.locator('#recordPanel').evaluate(n=>{ n.scrollTop=n.scrollHeight; });
  const undo = page.locator('.toast [data-undo]');
  const box = await undo.boundingBox();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x+box.width <= width && box.y+box.height <= 960,'Undo stays inside the viewport while the detail scrolls');
  assert.equal(await undo.evaluate(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'the scrolled detail never covers Undo');
  await page.clock.runFor(1501);
  assert.equal(await undo.isEnabled(),true);
  assert.equal(await page.locator('.toast').evaluate(n=>n.classList.contains('is-leaving')),true);
  await page.clock.runFor(800);
  assert.equal(await page.locator('.toast').count(),0);
  assert.deepEqual(errors,[]);
});

for (const width of [390,1280]) test(`move success fades after two seconds and Undo is clickable during the fade at ${width}px`, async t => {
  const {page,errors}=await open(t,{width});
  await page.locator('.kanban-column [data-id="d14"] .card-open').click();
  await page.locator('#detailPhase').selectOption('legal');
  await page.locator('#completionConfirm').click();
  await page.locator('#completionDialog').waitFor({state:'hidden'});
  await page.clock.runFor(2001);
  assert.equal(await page.locator('.toast').evaluate(n=>n.classList.contains('is-leaving')),true,'moves use the ordinary success fade');
  const undo=page.locator('.toast [data-undo]');
  assert.equal(await undo.isEnabled(),true);
  await undo.click({timeout:500});
  await waitForAsync(page,async()=>(await import('/js/pipeline.js')).state.deals.get('d14').phase==='Negotiation');
  await page.clock.runFor(2801);
  assert.equal(await page.locator('.toast').count(),0);
  assert.deepEqual(errors,[]);
});

test('unreadable linked client with no context rows hides the context control',async t=>{
  const {page,errors}=await open(t,{deal:'d02'});
  await page.locator('#detailUpdateForm').waitFor();
  assert.equal(await page.locator('#panelContextOpenWrap').isVisible(),false);
  assert.equal(await page.locator('#contextDrawer').evaluate(n=>n.open),false);
  assert.deepEqual(errors,[]);
});

test('context becoming unreadable on its fresh open closes the empty dialog and hides its control',async t=>{
  const {page,errors}=await open(t);
  await page.evaluate(async()=>{
    const {state}=await import('/js/pipeline.js');const read=state.client.getDeal.bind(state.client);
    state.client.getDeal=async id=>{const detail=await read(id);return {...detail,deal:{...detail.deal,client_id:'demo-context-client',account_client_id:null},critical_dates:[],participants:[]};};
    state.client.getPartyRecord=async()=>{if(window.contextUnavailable)throw Error('Synthetic unreadable client');return {record:{id:'demo-context-client',name:'Demo Context Client'}};};
    state.client.getRelationshipNetwork=async()=>({nodes:[],edges:[]});
  });
  await page.locator('.kanban-column [data-id="d14"] .card-open').click();
  await page.locator('#panelContextOpen').waitFor({state:'visible'});
  await page.evaluate(()=>{window.contextUnavailable=true;});
  await page.locator('#panelContextOpen').click();
  await waitForAsync(page,()=>!document.querySelector('#contextDrawerBody').textContent.includes('Updating'));
  assert.equal(await page.locator('#contextDrawer').evaluate(n=>n.open),false);
  assert.equal(await page.locator('#panelContextOpenWrap').isVisible(),false);
  assert.deepEqual(errors,[]);
});

test('readable vendor context survives a failed linked client read',async t=>{
  const {page,errors}=await open(t);
  await page.evaluate(async()=>{
    const {state}=await import('/js/pipeline.js');
    const read=state.client.getDeal.bind(state.client);state.client.getDeal=async id=>{const detail=await read(id);return {...detail,deal:{...detail.deal,client_id:'demo-unreadable'},critical_dates:[],participants:[]};};
    state.client.getPartyRecord=async()=>{throw Error('Synthetic unreadable client');};
    state.client.getRelationshipNetwork=async()=>({nodes:[{id:'party:demo-vendor',record_id:'demo-vendor',kind:'vendor',name:'Demo Vendor'}],edges:[{from:'party:demo-vendor',to:'deal:d14',kind:'referred'}]});
  });
  await page.locator('.kanban-column [data-id="d14"] .card-open').click();
  await page.locator('#panelContextOpen').waitFor({state:'visible'});
  await page.locator('#panelContextOpen').click();
  await page.locator('#contextDrawer a[href="/vendors?record=demo-vendor"]').waitFor();
  assert.equal(await page.locator('#contextDrawer .panel-section').count(),1);
  assert.deepEqual(errors,[]);
});

test('desktop next steps wrap to two lines and retain the full recorded text',async t=>{
  const {page,errors}=await open(t,{width:1280,review:true});
  const line=page.locator('.kanban-column [data-id="d14"] .next-line');
  const box=await line.evaluate(n=>{const s=getComputedStyle(n);return {height:n.getBoundingClientRect().height,lineHeight:parseFloat(s.lineHeight),text:n.textContent,title:n.title,width:n.clientWidth,scrollWidth:n.scrollWidth};});
  assert.ok(box.height>box.lineHeight*1.5 && box.height<=box.lineHeight*2+1,JSON.stringify(box));
  assert.equal(box.text,'Confirm the next appointment');
  assert.equal(box.title,box.text);
  const full='Confirm the next appointment with the demo practice and review the complete recorded lease terms before the next joint review.';
  await page.evaluate(async full=>{const {state}=await import('/js/pipeline.js');await state.client.setNextStep({deal:'d14',text:full,idempotency_key:'demo-full-next-step'});await state.boardSync.refreshBoard({reason:'test'});},full);
  assert.equal(await line.textContent(),full);
  assert.equal(await line.getAttribute('title'),full);
  await page.evaluate(async()=>{
    const {state}=await import('/js/pipeline.js');const read=state.client.getBoard.bind(state.client);
    state.client.getBoard=async(...args)=>{const board=await read(...args);board.deals.find(d=>d.id==='d14').next_step={text:'Counsel replied'};return board;};
    await state.boardSync.refreshBoard({reason:'test'});
  });
  assert.equal(await line.textContent(),'Counsel replied','structured notes render as the recorded sentence');
  assert.deepEqual(errors,[]);
});

test('a delayed context availability probe cannot hide a newer readable drawer',async t=>{
 const {page,errors}=await open(t);
 await page.evaluate(async()=>{
  const {state}=await import('/js/pipeline.js');const read=state.client.getDeal.bind(state.client);
  state.client.getDeal=async id=>{const detail=await read(id);return {...detail,deal:{...detail.deal,client_id:'demo-client'},critical_dates:[],participants:[]};};
  state.client.getPartyRecord=async()=>({record:{id:'demo-client',name:'Demo Current Client'}});
 });
 await page.locator('.kanban-column [data-id="d14"] .card-open').click();
 await page.locator('#panelContextOpen').waitFor({state:'visible'});
 await page.evaluate(async()=>{
  const {state}=await import('/js/pipeline.js');const read=state.client.getPartyRecord;let first=true;
  state.client.getPartyRecord=args=>{if(first){first=false;return new Promise(resolve=>{window.finishAvailability=()=>resolve({record:null});});}return read(args);};
  dispatchEvent(new Event('online'));
 });
 await waitForAsync(page,()=>typeof window.finishAvailability==='function');
 await page.locator('#panelContextOpen').click();
 await page.getByText('Demo Current Client',{exact:true}).waitFor();
 await page.evaluate(()=>window.finishAvailability());
 await page.locator('#contextDrawerClose').click();
 assert.equal(await page.locator('#panelContextOpenWrap').isVisible(),true);
 assert.deepEqual(errors,[]);
});
