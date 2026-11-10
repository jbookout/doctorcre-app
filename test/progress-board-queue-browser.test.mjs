import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { pausedClock } from './browser-harness.mjs';
import axe from 'axe-core';
import hierarchy from './fixtures/progress-board-hierarchy.json' with { type: 'json' };
import orchestratorSequence from './fixtures/progress-orchestrator.json' with {type:'json'};
import { open, queueRead, queueJob, systemPath, projectPath } from './progress-board-page-fixture.mjs';

const prFact = (card_id, number, state, draft = false) => ({ repo: 'jbookout/doctorcre-app', number, url: `https://github.com/jbookout/doctorcre-app/pull/${number}`,
  title: `Synthetic PR ${number}`, draft, state, updated_at: '2026-10-27T12:00:00Z', card_id: `${card_id}.app#${number}` });
const stagedQueue = queueRead([
  queueJob('WR557.S4.J1', 'review', { work_request_title: 'One Work Request queue', prs: [prFact('WR557.S4.J1', 12, 'open')] }),
  queueJob('WR557.S4.J2', 'build', { work_request_title: 'One Work Request queue', card_title: 'Delete board path', stale: true, prs: [prFact('WR557.S4.J2', 13, 'open', true)] }),
  queueJob('WR557.S1.J2', 'merged', { work_request_title: 'One Work Request queue', card_title: 'Record lean jobs', prs: [prFact('WR557.S1.J2', 9, 'merged')] }),
  queueJob('WR557.S4.J3', 'running', { work_request_title: 'One Work Request queue' }),
  queueJob('WR557.S4.J4', 'merged', { work_request_title: 'One Work Request queue', prs: [{ ...prFact('WR557.S4.J4', 14, 'merged'), production_live: true }] }),
  queueJob('WR562.S1.J1', 'queued', { work_request_title: 'Team memory', card_title: 'Memory design' }),
], ['DoctorCRE/carr-system', 'jbookout/doctorcre-app', 'jbookout/software-factory'].map(repo => ({ repo, state: 'ok', truncated: false })));

for (const width of [390, 1280]) for (const theme of ['light', 'dark'])
  test(`system board shows every stage with WR.S.J IDs, Work Request titles and PR links at ${width}px ${theme}`, async t => {
    const { page, errors } = await open(t, { width, path: systemPath, queue: stagedQueue });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.locator('#board-stages [data-card-id="WR557.S4.J1"]').waitFor();
    assert.deepEqual(await page.locator('#board-stages .column').evaluateAll(columns => columns.map(column =>
      `${column.dataset.stage}:${column.querySelectorAll('[data-card-id]').length}`)), ['queued:1', 'running:1', 'build:1', 'review:1', 'merged:1', 'live:1', 'closed:0']);
    assert.match(await page.locator('.column[data-stage="closed"]').textContent(), /PR closed without merging/);
    const review = page.locator('[data-card-id="WR557.S4.J1"]');
    assert.match(await review.textContent(), /WR557\.S4\.J1.*Synthetic queue work/);
    assert.equal(await review.locator('a').getAttribute('href'), 'https://github.com/jbookout/doctorcre-app/pull/12');
    assert.equal(await review.locator('a').textContent(), 'WR557.S4.J1.app#12 · open');
    assert.equal(await page.locator('.column[data-stage="review"] .queue-group').textContent(), 'WR-000557 · One Work Request queue');
    assert.equal(await page.locator('[data-card-id="WR557.S4.J2"] a').textContent(), 'WR557.S4.J2.app#13 · draft');
    assert.deepEqual(await page.locator('#board-stages .flag-stale').evaluateAll(flags => flags.map(flag => flag.closest('[data-card-id]').dataset.cardId)),
      ['WR557.S4.J2'], 'only the server-flagged job is stale');
    assert.match(await page.locator('.queue-board-status').textContent(), /6 jobs · 1 stale \(no progress for 24 hours while queued or building\)/);
    if (width === 1280) {
      const positions = await page.locator('#board-stages .column').evaluateAll(columns => columns.map(column => ({ x: column.getBoundingClientRect().x, y: column.getBoundingClientRect().y })));
      assert.ok(positions[1].x > positions[0].x && positions[1].y === positions[0].y, 'desktop stages appear side by side');
    }
    assert.equal(await page.locator('#task-count').textContent(), '6 jobs');
    for (const id of ['board-questions', 'board-blocked', 'board-ledger', 'board-deliverables', 'board-decisions', 'board-notes', 'board-completed'])
      assert.equal(await page.locator(`#${id}`).evaluate(el => el.closest('.panel').hidden), true, `${id} stays hidden on the queue board`);
    assert.equal(await page.locator('.headline').isVisible(), false, 'the retired snapshot headline is gone');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.evaluate(axe.source);
    assert.deepEqual(await page.evaluate(async () => (await axe.run('#board-stages')).violations.map(v => v.id)), []);
    assert.deepEqual(errors, []);
    await mkdir('test-artifacts/work-queue', { recursive: true });
    await page.screenshot({ path: `test-artifacts/work-queue/${width}-${theme}.png`, fullPage: true });
  });

test('every queued job is reachable: 250 review jobs render with no cap and the column scrolls', async t => {
  const jobs = Array.from({ length: 250 }, (_, index) => queueJob(`WR600.S1.J${index + 1}`, 'review', { j_number: index + 1 }));
  const { page, errors } = await open(t, { width: 1280, path: systemPath, queue: queueRead(jobs) });
  await page.locator('[data-card-id="WR600.S1.J250"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#board-stages [data-card-id]').count(), 250);
  const body = page.locator('.column[data-stage="review"] .column-body');
  assert.equal(await body.evaluate(node => node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === 'auto'), true);
  await page.locator('[data-card-id="WR600.S1.J250"]').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('[data-card-id="WR600.S1.J250"]').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('the system board reads the queue once per 60 seconds, never while hidden, and stops after 5 idle minutes', async t => {
  const { page, calls, errors, setQueue } = await open(t, { width: 1280, path: systemPath,
    setupPage: page => pausedClock(page, new Date('2026-10-27T12:00:00Z')) });
  await page.locator('[data-card-id="WR14.S1.J1"]').waitFor();
  await page.waitForLoadState('networkidle');
  const count = name => calls.filter(call => call.name === name).length;
  const reads = () => count('work-queue');
  assert.equal(reads(), 1, 'one read on open');
  const snapshot = count('read-progress-board'), census = count('unfinished-work');
  setQueue(queueRead([queueJob('WR14.S1.J1', 'review', { card_title: 'First refresh completed' })]));
  await page.mouse.move(10, 10);
  await page.clock.runFor(59_000);
  assert.equal(reads(), 1, 'no read before the interval');
  await page.clock.runFor(1_500);
  await page.getByText('First refresh completed', { exact: true }).waitFor();
  assert.equal(reads(), 2, 'one read per interval');
  setQueue(queueRead([queueJob('WR14.S1.J1', 'review', { card_title: 'Second refresh completed' })]));
  await page.mouse.move(20, 20);
  await page.clock.runFor(60_500);
  await page.getByText('Second refresh completed', { exact: true }).waitFor();
  assert.equal(reads(), 3, 'never more than one read per interval');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(5 * 60_000);
  assert.equal(reads(), 3, 'a hidden tab makes no reads');
  setQueue(queueRead([queueJob('WR14.S1.J1', 'review', { card_title: 'Visible refresh completed' })]));
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(reads(), 3, 'a lifecycle return after idle cannot renew presence');
  await page.mouse.move(30, 30);
  await page.getByText('Visible refresh completed', { exact: true }).waitFor();
  await page.clock.runFor(500);
  assert.equal(reads(), 4, 'real input after the idle return reads once');
  await page.clock.runFor(10 * 60_000);
  const idle = reads();
  assert.ok(idle <= 4 + Math.ceil(5 * 60_000 / 60_000), `reads stop at the 5-minute idle cutoff (${idle})`);
  await page.clock.runFor(30 * 60_000);
  assert.equal(reads(), idle, 'an idle visible tab makes no reads');
  assert.equal(count('read-progress-board'), snapshot, 'the snapshot is never polled on the queue board');
  assert.equal(count('unfinished-work'), census, 'the census is never polled on the queue board');
  assert.deepEqual(errors, []);
});

test('an unreviewed fixture preview renders the demo queue without calling the live board', async t => {
  const { page, calls, errors } = await open(t, {path:'/control-room/progress/board/carr-v5?mode=fixture', boardRead:'failed'});
  await page.locator('[data-card-id="WR901.S1.J1"]').waitFor({ timeout: 3000 });
  assert.equal(calls.filter(call => ['work-queue', 'read-progress-board'].includes(call.name)).length, 0);
  assert.match(await page.locator('#board-stages').textContent(), /Demo dashboard refresh/);
  assert.deepEqual(errors, []);
});

for (const status of [401, 403]) test(`denied hierarchy read ${status} stays empty through browser Back and recovers unchanged data`, async t => {
  let denied = false;
  const {page, errors} = await open(t, {path:projectPath, snapshotData:hierarchy, control:async(route,rpc)=>{
    if (!denied || rpc.name !== 'read-progress-board') return false;
    await route.fulfill({status, body:'{}'});
    return true;
  }});
  const original = page.url();
  const cards = page.locator('#board-stages [data-hierarchy-id]');
  await page.locator('[data-hierarchy-id="WR14"] > button').click();
  assert.equal(await cards.count(), 2);
  denied = true;
  await page.clock.runFor(60_000);
  await page.waitForURL('**/public-shell/session-ended.html*');
  assert.equal(await cards.count(), 0);
  await page.goBack();
  await page.waitForURL('**/public-shell/session-ended.html*');
  assert.equal(await cards.count(), 0);
  denied = false;
  await page.goto(original);
  await page.locator('[data-hierarchy-id="WR14"]').waitFor();
  assert.equal(await cards.count(), 1);

  assert.deepEqual(errors, []);
});

for (const status of [401, 403]) test(`denied work-queue read ${status} clears the queue and recovers it after browser Back`, async t => {
  let denied = false;
  const {page, calls, errors} = await open(t, {path:systemPath, control:async(route,rpc)=>{
    if (!denied || rpc.name !== 'work-queue') return false;
    await route.fulfill({status, body:'{}'});
    return true;
  }});
  const cards = page.locator('#board-stages [data-card-id]');
  await cards.first().waitFor();
  await page.evaluate(() => history.pushState({}, '', location.pathname + '?view=queue'));
  const original = page.url();
  denied = true;
  await page.mouse.move(10, 10);
  await page.clock.runFor(61_000);
  await page.waitForURL('**/public-shell/session-ended.html*', { waitUntil: 'commit' });
  assert.equal(await cards.count(), 0);
  await page.goBack();
  await page.waitForURL('**/public-shell/session-ended.html*', { waitUntil: 'commit' });
  assert.equal(await cards.count(), 0);
  denied = false;
  await page.goto(original);
  await cards.first().waitFor();
  assert.equal(await cards.count(), 1);
  assert.deepEqual(errors, []);
});

test('leaving a job through browser history closes its actual detail dialog', async t => {
  const { page, errors } = await open(t, {path:projectPath, snapshotData:hierarchy, autoMount:false});
  await page.evaluate(async ({fixture, html}) => {
    const {mountBoard} = await import('/js/progress-board.js');
    const {mountJobDetail} = await import('/js/job-detail.js');
    const template = new DOMParser().parseFromString(html, 'text/html');
    document.body.append(template.getElementById('jobDialog'));
    const client = {readProgressBoard:async()=>({snapshot:{version:1,snapshot_json:fixture}})};
    const detail = mountJobDetail({client, document});
    window.historyBoard = mountBoard({window, client, openTask:task=>detail.open(task), closeTask:()=>detail.clear()});
    await window.historyBoard.refresh(true);
  }, {fixture:hierarchy, html:await readFile(new URL('../control-room.html', import.meta.url), 'utf8')});
  const card = id => page.locator(`[data-hierarchy-id="${id}"] > button`);
  await card('WR14').click();
  await card('WR14.S2').click();
  await card('WR14.S2.J1.app#316').click();
  const dialog = page.locator('#jobDialog');
  await dialog.waitFor({state:'visible'});
  assert.equal(await page.locator('#jobTitle').textContent(), 'Board navigation');
  await page.goBack();
  assert.equal(new URL(page.url()).searchParams.get('card'), 'WR14.S2');
  assert.equal(await dialog.isVisible(), false);
  await page.goForward();
  await dialog.waitFor({state:'visible'});
  await page.goBack();
  await page.goBack();
  assert.equal(new URL(page.url()).searchParams.get('card'), 'WR14');
  assert.equal(await dialog.isVisible(), false);
  await page.goBack();
  assert.equal(new URL(page.url()).searchParams.get('card'), null);
  assert.equal(await dialog.isVisible(), false);
  assert.deepEqual(errors, []);
});

for (const width of [390,1280]) for (const theme of ['light','dark'])
  test(`orchestrator published queue observations update in place at ${width}px ${theme}`, async t => {
    const {page,errors,setSnapshot}=await open(t,{width,timezoneId:'America/Chicago',
      path:'/control-room/progress/board/orchestrator',snapshotData:orchestratorSequence[0].snapshot.snapshot_json,
      assetRoot:process.env.ORCHESTRATOR_BUILT_ROOT ? new URL(`file://${process.env.ORCHESTRATOR_BUILT_ROOT}/`) : undefined});
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const first=page.locator('[data-orchestrator-card]').first();await first.waitFor();
    if (width === 1280) {
      const position = await page.evaluate(() => ({main:document.querySelector('.progress-main').getBoundingClientRect().left, pipeline:document.querySelector('.pipeline-panel').getBoundingClientRect().left}));
      assert.ok(Math.abs(position.main-position.pipeline) < 2, 'a hidden directory reserves no left column');
    }
    const box=await first.locator('.orchestrator-progress').boundingBox();
    if(width===390) assert.ok(box && box.y+box.height<820,'first title, status and progress fit above phone navigation');
    await mkdir('test-artifacts/orchestrator',{recursive:true});
    await page.screenshot({path:`test-artifacts/orchestrator/initial-${width}-${theme}.png`});
    const olderPage='orchestrator-page-'+'a'.repeat(64);
    let pageUnavailable=true;
    await page.route('**/mcp', async route => {
      const rpc=route.request().postDataJSON().params;
      if(rpc?.name!=='read-progress-board' || rpc.arguments.board_id!==olderPage) return route.fallback();
      if(pageUnavailable) return route.fulfill({status:503,contentType:'application/json',body:'{}'});
      return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{text:JSON.stringify({snapshot:{version:1,snapshot_json:{cards:[{
        id:'older-release',title:'Older unresolved release',state:'merged',owner:'cx-app2',prs:[],changed_at:'2026-01-01T00:00:00Z'
      }]}}})}]}})});
    });
    await page.locator('[data-orchestrator-card="queue:search"]').waitFor();
    await page.evaluate(()=>{
      window.__orchestratorCard=document.querySelector('[data-orchestrator-card="queue:search"]');
      window.__orchestratorLink=window.__orchestratorCard.querySelector('a');
      window.__orchestratorLink.focus({preventScroll:true});
      window.__orchestratorCard.querySelector('details').open=true;
    });
    for(const [index,state] of [[1,'working'],[2,'review'],[3,'fixing'],[4,'merging'],[5,'merged'],[6,'live']]) {
      setSnapshot(orchestratorSequence[index].snapshot.snapshot_json);
      await page.clock.runFor(index <= 5 ? 60_100 : 120_100);
      await page.locator(`[data-orchestrator-stage="${state}"] [data-orchestrator-card="queue:search"]`).waitFor();
      assert.equal(await page.evaluate(()=>document.querySelector('[data-orchestrator-card="queue:search"]')===window.__orchestratorCard),true);
      assert.equal(await page.evaluate(()=>document.activeElement===window.__orchestratorLink),true);
      assert.equal(await page.locator('[data-orchestrator-card="queue:search"] details').getAttribute('open'),'');
    }
    setSnapshot(orchestratorSequence[7].snapshot.snapshot_json);
    await page.clock.runFor(120_100);
    await page.locator('[data-orchestrator-status]').filter({hasText:'Queue observation unavailable or stale'}).waitFor();
    assert.equal(await page.locator('[data-orchestrator-stage="live"] [data-orchestrator-card="queue:search"]').count(),1);
    assert.equal(await page.locator('[data-orchestrator-stage]').count(),8);
    const paged=structuredClone(orchestratorSequence[7].snapshot.snapshot_json);
    paged.orchestrator.total_cards=paged.orchestrator.cards.length+1;
    paged.orchestrator.pages=[{board_id:olderPage,version:1,count:1}];
    setSnapshot(paged);await page.clock.runFor(120_100);
    await page.locator('[data-orchestrator-more]').click();
    await page.locator('[data-orchestrator-pagination]').filter({hasText:'unavailable'}).waitFor();
    assert.equal(await page.locator('[data-orchestrator-card="queue:search"]').count(),1);
    pageUnavailable=false;await page.locator('[data-orchestrator-more]').click();
    await page.locator('[data-orchestrator-card="older-release"]').waitFor();
    assert.match(await page.locator('[data-orchestrator-card="older-release"]').textContent(),/Merged \/ awaiting release/);
    const older=page.locator('[data-orchestrator-card="older-release"]');
    await older.locator('details').evaluate(el=>el.open=true);
    await older.locator('summary').focus();
    const scroll=await older.evaluate(el=>el.closest('.app-layout-center').scrollTop);
    const changed=structuredClone(paged);changed.orchestrator.observed_at='2026-10-21T20:00:00Z';
    changed.orchestrator.cards[0].state='fixing';setSnapshot(changed);await page.clock.runFor(120_100);
    assert.equal(await older.locator('details').getAttribute('open'),'');
    assert.equal(await older.locator('summary').evaluate(el=>el===document.activeElement),true);
    assert.equal(await older.evaluate(el=>el.closest('.app-layout-center').scrollTop),scroll);
    setSnapshot({tasks:{}});await page.clock.runFor(120_100);
    setSnapshot(changed);await page.clock.runFor(240_300);
    assert.equal(await older.count(),1);


    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const targets=await page.locator('.orchestrator-count,.orchestrator-links a,.orchestrator-detail summary').evaluateAll(nodes=>nodes.map(el=>el.getBoundingClientRect().height));
    assert.ok(targets.every(height=>height>=44));
    const violations=await page.evaluate(async source=>{eval(source);return (await axe.run(document.querySelector('#board-stages'))).violations;},axe.source);
    assert.deepEqual(violations.map(v=>v.id),[]);
    assert.deepEqual(errors,[]);
    await mkdir('test-artifacts/orchestrator',{recursive:true});
    await page.screenshot({path:`test-artifacts/orchestrator/${width}-${theme}.png`,fullPage:true});
  });


test('session invalidation disposes board callbacks before its document is cleared', async t => {
  const {page, errors} = await open(t, {path:projectPath, autoMount:false});
  const result = await page.evaluate(async fixture => {
    const {mountBoard} = await import('/js/progress-board.js');
    let reads = 0;
    const client = {readProgressBoard:async()=>{reads++; return {snapshot:{version:1,snapshot_json:fixture}};}};
    const board = mountBoard({window, client});
    await board.refresh(true);
    window.dispatchEvent(new Event('doctorcre-session-invalidated'));
    document.body.replaceChildren();
    await board.refresh(true);
    board.tick();
    return {reads, text:document.body.textContent};
  }, {title:'Demo project', tasks:{build:{title:'Synthetic build', status:'running'}}});
  assert.deepEqual(result, {reads:1, text:''});
  assert.deepEqual(errors, []);
});

for (const width of [390,1440]) test(`standalone work views keep a bounded queue and restore scroll and card focus at ${width}px`,async t=>{
  const snapshotData = {title:'Synthetic delivery',tasks:{
    build:{title:'Build the synthetic export',status:'running',updated_at:new Date().toISOString()},
    completed:{title:'Use the synthetic export',status:'done'},
    blocked:{title:'Resolve the synthetic dependency',status:'blocked'},
    ...Object.fromEntries(Array.from({length:100},(_,i)=>[`queue-${i}`,{title:`Synthetic queued outcome ${i}`,status:'queued'}])),
  }};
  const {page,errors}=await open(t,{width,height:900,path:'/control-room/progress/board/demo-project',snapshotData});
  await page.locator('[data-work-view="active"]').waitFor();
  assert.deepEqual(await page.locator('#board-stages .board-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.cardId)),['build']);
  const geometry=await page.evaluate(()=>({
    lane:document.querySelector('#board-stages .column').getBoundingClientRect().top,
    filters:document.querySelector('#board-filters').getBoundingClientRect().top,
  }));
  assert.ok(geometry.lane<900 && geometry.filters<900,'lanes and filters start in the first viewport');
  if(width===1440) {
    const layout=await page.evaluate(()=>({menu:document.querySelector('.work-view-menu').getBoundingClientRect().toJSON(),pipeline:document.querySelector('.pipeline-panel').getBoundingClientRect().toJSON(),directory:document.querySelector('.directory-panel').getBoundingClientRect().toJSON()}));
    assert.ok(layout.menu.left>=layout.pipeline.right,`the desktop view menu sits to the right of work ${JSON.stringify(layout)}`);
    assert.ok(layout.directory.right<=layout.pipeline.left,'the desktop directory sits to the left of work');
  }
  await page.locator('[data-work-view="completed"]').click();
  assert.deepEqual(await page.locator('#board-stages .board-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.cardId)),['completed']);
  await page.locator('[data-work-view="attention"]').click();
  assert.deepEqual(await page.locator('#board-stages .board-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.cardId)),['blocked']);
  await page.locator('[data-work-view="queue"]').click();
  assert.equal(await page.locator('#board-stages .board-card').count(),20);
  const laneWidth=await page.locator('#board-stages .column').evaluate(node=>node.getBoundingClientRect().width/node.parentElement.getBoundingClientRect().width);
  assert.ok(laneWidth>0.8,'a single queue lane uses the available work width');
  const toggle=page.getByRole('button',{name:'Show all queued cards'});
  await toggle.click();
  assert.equal(await page.locator('#board-stages .board-card').count(),100);
  const selected=page.locator('[data-card-id="queue-75"]');
  await selected.focus();
  await selected.scrollIntoViewIfNeeded();
  const previous=await page.locator('.app-layout-center').evaluate(node=>node.scrollTop);
  assert.ok(previous>1000,'the queue is deeply scrolled');
  await page.locator('[data-work-view="completed"]').click();
  await page.locator('[data-work-view="queue"]').click();
  assert.equal(await selected.evaluate(node=>node===document.activeElement),true,'return restores the selected card');
  const restored=await page.locator('.app-layout-center').evaluate(node=>node.scrollTop);
  assert.ok(Math.abs(restored-previous)<2,`return restores this view scroll, before ${previous}, after ${restored}`);
  const fewer=page.getByRole('button',{name:'Show fewer queued cards'});
  const box=await fewer.boundingBox();
  assert.ok(box.y>=0 && box.y+box.height<900,'Show fewer stays reachable deep in a lane');
  if(width===390) {
    const menu=await page.getByRole('navigation',{name:'Work views',exact:true}).boundingBox();
    assert.ok(box.y>=menu.y+menu.height,'Show fewer stays below the wrapped view selector');
  }
  if(width===1440) {
    const position=await page.locator('.column-head').evaluate(node=>({
      top:node.getBoundingClientRect().top,
      toolbar:document.querySelector('.app-layout-tabbar').getBoundingClientRect().bottom,
    }));
    assert.ok(Math.abs(position.top-position.toolbar)<2,'desktop lane header stays directly below the toolbar');
  }
  await fewer.click();
  assert.equal(await page.locator('#board-stages .board-card').count(),20);
  assert.equal(await page.getByRole('button',{name:'Show all queued cards'}).evaluate(node=>node===document.activeElement),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await mkdir('test-artifacts/progress-views',{recursive:true});
  await page.screenshot({path:`test-artifacts/progress-views/queue-${width}.png`});
  assert.deepEqual(errors,[]);
});

test('ordinary standalone project board exposes snapshot work views when the census read is available',async t=>{
  const {page,errors}=await open(t,{path:projectPath});
  await page.locator('#board-stages [data-card-id="build"]').waitFor();
  assert.equal(await page.locator('[data-work-view="active"]').isVisible(),true);
  assert.deepEqual(errors,[]);
});
