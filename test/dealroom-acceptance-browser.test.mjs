import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, 'out/test-artifacts/dealroom-acceptance');
let outDir, server, browser, origin;
before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'dealroom-acceptance-'));
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  ({ server } = await createQaServer({ buildRoot: join(outDir, 'site') }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  await mkdir(evidence, { recursive: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) test(`signed-in deal room preserves board rows and unobstructed titles at ${width}px in ${theme}`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 960 }, timezoneId: 'America/Chicago', reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({theme})), theme);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const seeded = await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `dealroom-${width}-${theme}`, viewer: 'joe', reset: true } });
  assert.equal(seeded.status(), 200);
  const response = await page.request.post(`${origin}/mcp`, { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'deal-room-board', arguments: {} } } });
  const envelope = await response.json();
  const board = JSON.parse(envelope.result.content[0].text);
  assert.equal(board.schema_version, 'local-deals-board.v2');
  assert.equal(board.actor, 'joe');
  assert.equal(board.deals.length, 16);
  assert.deepEqual(board.closed_deals, []);
  assert.deepEqual(board.lost_deals, []);
  await page.goto(`${origin}/deals?mode=live`);
  await page.locator('.kanban-card').first().waitFor();
  const ids = await page.locator('.kanban-column .kanban-card').evaluateAll(nodes => nodes.map(node => node.dataset.id).sort());
  assert.deepEqual(ids, board.deals.map(deal => deal.id).sort());
  assert.equal(await page.locator('.kanban-column').count(), 7);
  assert.equal(await page.locator('[data-column="closed"]').count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /Nothing needs you/i);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(evidence, `${width}-${theme}-board.png`), animations: 'disabled' });
  await page.getByRole('button', { name: 'Dell', exact: true }).click();
  const dellIds = await page.locator('.kanban-column .kanban-card').evaluateAll(nodes => nodes.map(node => node.dataset.id).sort());
  assert.deepEqual(dellIds, board.deals.filter(deal => deal.owner === 'dell').map(deal => deal.id).sort());
  await page.locator('.card-open').first().click();
  await page.locator('#detailUpdateForm').waitFor();
  assert.equal(await page.getByLabel('Update', { exact: true }).inputValue(), '');
  assert.equal(await page.locator('#dealUpdate').getAttribute('placeholder'), null);
  assert.equal(await page.locator('[aria-label="Deal phases and timeline"]').count(), 1);
  assert.equal(await page.locator('.timeline-chart').count(), 0);
  assert.equal(await page.locator('#detailOwner').inputValue(), 'dell');
  assert.equal(await page.locator('.deal-updates').count(), 0, 'the signed-in empty note feed renders no section');
  assert.equal(await page.locator('#recordPanel').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: join(evidence, `${width}-${theme}-snapshot.png`), animations: 'disabled' });
  const header = await page.locator('#recordPanel > header').evaluate(node => ({
    stackHeight: node.getBoundingClientRect().bottom - node.parentElement.getBoundingClientRect().top,
    titleFontSize: parseFloat(getComputedStyle(node.querySelector('h1')).fontSize),
    paddingTop: parseFloat(getComputedStyle(node).paddingTop),
  }));
  assert.ok(header.stackHeight < 360, 'persistent header leaves room for workspace content');
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  await page.evaluate(async()=>{
    const {state}=await import('/js/pipeline.js');const read=state.client.getDeal;
    state.client.getDeal=async id=>{const detail=await read(id);return {...detail,deal:{...detail.deal,vendors:Array.from({length:6},(_,i)=>({party_id:`demo-vendor-${i}`,role:i<3?'lender':'landlord_rep',company:{id:`demo-company-${i}`,name:`Demo regional healthcare property and finance company ${i}`},contact:{id:`demo-contact-${i}`,name:`Demo assigned representative number ${i}`}}))},thread:Array.from({length:30},(_,i)=>({id:`demo-${i}`,kind:'note',actor:'joe',text:`Demo update ${i}. `+'Synthetic context. '.repeat(20),recorded_at:new Date(Date.UTC(2026,9,20,12,0,i)).toISOString()}))};};
  });
  await page.getByRole('button',{name:'Refresh deal',exact:true}).click();
  await page.locator('.updates-history > summary').waitFor();
  assert.equal(await page.locator('#recordPanel .deal-vendor-company').count(),6);
  const action=await page.getByRole('button',{name:'Add update',exact:true}).boundingBox();
  const panel=await page.locator('#recordPanel').boundingBox();
  assert.ok(action.y+action.height<=panel.y+panel.height,JSON.stringify({action,panel}));
  await page.screenshot({path:join(evidence,`${width}-${theme}-six-vendors.png`),animations:'disabled'});
  await page.locator('.deal-updates').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(evidence,`${width}-${theme}-summary.png`),animations:'disabled'});
  await page.locator('.updates-history > summary').click();
  await page.evaluate(() => scrollTo(0,220));
  await page.screenshot({ path: join(evidence, `${width}-${theme}-scrolled.png`), animations: 'disabled' });
  const titleHitTest = await page.locator('#panelTitle').evaluate(title => {
    const orb = document.querySelector('#recordPanel .doc-presence').getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(title);
    const text = range.getBoundingClientRect();
    const hits = [...range.getClientRects()].flatMap(rect => [rect.left + 1, (rect.left + rect.right) / 2, rect.right - 1].map(x => {
      const hit = document.elementFromPoint(x, (rect.top + rect.bottom) / 2);
      return {x, visible: hit === title || title.contains(hit)};
    }));
    return {scrollTop: scrollY, orb: orb.toJSON(), text: text.toJSON(), hits,
      overlaps: orb.left < text.right && orb.right > text.left && orb.top < text.bottom && orb.bottom > text.top};
  });
  await writeFile(join(evidence, `${width}-${theme}-hit-test.json`), JSON.stringify({...titleHitTest, header}, null, 2));
  assert.ok(titleHitTest.scrollTop > 100, 'exercise the sticky header after scrolling');
  assert.equal(titleHitTest.overlaps, false, JSON.stringify(titleHitTest));
  assert.ok(titleHitTest.hits.length > 0 && titleHitTest.hits.every(hit => hit.visible), JSON.stringify(titleHitTest));
  assert.deepEqual(errors, []);
});

for (const width of [390, 1280]) test(`signed-in Add deal persists through reload, HTTP replay and a second partner at ${width}px`, async t => {
  const page = await browser.newPage({ viewport:{width,height:960}, timezoneId:'America/Chicago', reducedMotion:'reduce' });
  const partner = await browser.newPage({ viewport:{width,height:960}, timezoneId:'America/Chicago', reducedMotion:'reduce' });
  t.after(() => Promise.all([page.close(),partner.close()]));
  const errors = [];
  for (const current of [page,partner]) current.on('pageerror',error => errors.push(error.message));
  const namespace = `create-deal-${width}`;
  await page.request.post(`${origin}/api/test/seed`,{data:{namespace,viewer:'joe',reset:true}});
  const writes = [];
  page.on('request',request => {
    if (new URL(request.url()).pathname !== '/mcp' || request.method() !== 'POST') return;
    const body = request.postDataJSON();
    if (['new-deal','set-lead','add-deal-note'].includes(body.params?.name)) writes.push(body);
  });
  await page.goto(`${origin}/deals?mode=live`);
  await page.locator('.kanban-card').first().waitFor();
  assert.equal(await page.evaluate(async () => (await import('/js/pipeline.js')).state.client.mode),'live');
  await page.getByRole('button',{name:'Add deal',exact:true}).click();
  await page.getByLabel('Deal name',{exact:true}).fill('Demo HTTP Partner Review');
  await page.getByLabel('Client',{exact:true}).fill('C-demo');
  await page.getByLabel('Owner',{exact:true}).selectOption('dell');
  await page.getByLabel('Type',{exact:true}).selectOption('renewal');
  await page.getByLabel('Stage',{exact:true}).selectOption('Research');
  await page.getByLabel('Notes',{exact:true}).fill('Demo HTTP initial review note');
  await page.getByRole('button',{name:'Create deal',exact:true}).click();
  const card = page.locator('.kanban-card').filter({hasText:'Demo HTTP Partner Review'});
  await card.waitFor();
  assert.equal(await card.count(),1);
  const id = await card.getAttribute('data-id');
  assert.deepEqual(writes.map(body => body.params.name),['new-deal','set-lead','add-deal-note']);
  assert.ok(writes.every(body => body.params.arguments.idempotency_key));
  const rpc = async (current,name,args={}) => {
    const response = await current.request.post(`${origin}/mcp`,{data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}});
    assert.equal(response.status(),200);
    const {result} = await response.json();
    assert.notEqual(result.isError,true);
    return JSON.parse(result.content[0].text);
  };
  const saved = await rpc(page,'get-deal-room',{deal:id});
  assert.equal(saved.owner,'dell');
  assert.equal(saved.thread.length,1);
  const note = saved.thread[0];
  assert.equal(note.actor,'joe');
  assert.equal(note.text,'Demo HTTP initial review note');
  assert.ok(Number.isFinite(Date.parse(note.recorded_at)));
  await page.reload();
  await card.waitFor();
  for (const body of writes) {
    const replay = await rpc(page,body.params.name,body.params.arguments);
    if (body.params.name === 'new-deal') assert.equal(replay.deal_id,id);
    else assert.equal(replay.ok,true);
  }
  const board = await rpc(page,'deal-room-board');
  assert.equal(board.deals.length,17);
  assert.equal(board.deals.filter(deal => deal.name === 'Demo HTTP Partner Review').length,1);
  assert.deepEqual((await rpc(page,'get-deal-room',{deal:id})).thread,[note]);
  await partner.request.post(`${origin}/api/test/seed`,{data:{namespace,viewer:'dell'}});
  assert.equal((await rpc(partner,'deal-room-board')).actor,'dell');
  await partner.goto(`${origin}/deals?mode=live&owner=dell&deal=${encodeURIComponent(id)}`);
  await partner.locator('#detailUpdateForm').waitFor();
  assert.equal(await partner.locator('#detailOwner').inputValue(),'dell');
  const renderedNote = partner.locator('.deal-note').filter({hasText:note.text});
  assert.equal(await renderedNote.count(),1);
  assert.equal(await renderedNote.locator('b').textContent(),'Joe');
  assert.equal(await renderedNote.locator('time').getAttribute('datetime'),note.recorded_at);
  assert.ok((await renderedNote.locator('time').textContent()).trim());
  assert.doesNotMatch(await renderedNote.locator('time').textContent(),/Date not recorded/);
  assert.deepEqual((await rpc(partner,'get-deal-room',{deal:id})).thread,[note]);
  assert.deepEqual(errors,[]);
});
