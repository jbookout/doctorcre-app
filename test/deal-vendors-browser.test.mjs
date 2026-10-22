import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, waitForAsync } from './browser-harness.mjs';

const root = new URL('../', import.meta.url);
const assignments = [
  { party_id: 'demo-v1', role: 'lender', company: { id: 'demo-c1', name: 'Demo Bank & Trust' }, contact: { id: 'demo-p1', name: 'Demo Contact <One>' } },
  { party_id: 'demo-v2', role: 'landlord_rep', company: { id: 'demo-c2', name: 'Demo Property Group' }, contact: { id: 'demo-p2', name: 'Demo Contact Two' } },
  { party_id: 'demo-v3', role: 'lender', company: { id: 'demo-c3', name: 'Demo Second Bank' }, contact: { id: 'demo-p3', name: 'Demo Contact Three' } },
];

async function open(t, width = 1280, theme = 'dark', vendors = assignments) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 960 } });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  const seed = JSON.parse(await readFile(new URL('data/board-seed.json', root), 'utf8'));
  seed.deals.find(d => d.id === 'd14').vendors = vendors;
  seed.deals.find(d => d.id === 'd06').vendors = vendors;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/data/board-seed.json') return route.fulfill({ json: seed });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
    const file = url.pathname === '/deals' ? 'pipeline.html' : url.pathname.slice(1);
    try {
      return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/deals');
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.size > 0);
  return { page, errors };
}

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) test(`deal vendor groups show company and contact at ${width}px in ${theme}`, async t => {
  const { page, errors } = await open(t, width, theme);
  const evidence = new URL('out/test-artifacts/deal-vendors/', root);
  await mkdir(evidence, { recursive: true });
  const card = page.locator('.kanban-column [data-id="d14"]');
  assert.equal(await card.locator('.deal-vendors').count(),0,'checklist cards contain no vendor prose');
  await card.scrollIntoViewIfNeeded();
  assert.equal(await card.evaluate(n => n.scrollWidth <= n.clientWidth), true);
  await page.screenshot({ path: new URL(`${width}-${theme}-board.png`, evidence).pathname, animations: 'disabled' });
  await card.locator('.card-open').click();
  await page.locator('#detailUpdateForm').waitFor();
  assert.equal(await page.locator('#recordPanel').locator('.deal-vendor-group').count(), 2);
  assert.deepEqual(await page.locator('#recordPanel').locator('.deal-vendor-role').allTextContents(), ['Lender', 'Landlord rep']);
  assert.deepEqual(await page.locator('#recordPanel').locator('.deal-vendor-company').allTextContents(), ['Demo Bank & Trust', 'Demo Second Bank', 'Demo Property Group']);
  assert.deepEqual(await page.locator('#recordPanel').locator('.deal-vendor-contact').allTextContents(), ['Demo Contact <One>', 'Demo Contact Three', 'Demo Contact Two']);
  assert.equal(await page.locator('#recordPanel').locator('.deal-vendor-contact one').count(), 0);
  assert.equal(await page.locator('#recordPanel .deal-vendor-group').count(), 2);
  assert.equal(await page.locator('#recordPanel').evaluate(n => n.scrollWidth <= n.clientWidth), true);
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  await page.screenshot({ path: new URL(`${width}-${theme}-detail.png`, evidence).pathname, animations: 'disabled' });
  assert.deepEqual(errors, []);
});

test('deal detail refresh replaces vendors and removes empty groups without losing the update draft', async t => {
  const { page, errors } = await open(t);
  await page.locator('.kanban-column [data-id="d14"] .card-open').click();
  await page.locator('#detailUpdateForm').waitFor();
  await page.getByLabel('Update', { exact: true }).fill('Demo draft remains');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const read = state.client.getDeal;
    state.client.getDeal = async id => {
      const detail = await read(id);
      return { ...detail, deal: { ...detail.deal, vendors: [] } };
    };
  });
  await page.getByRole('button', { name: 'Refresh deal', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#recordPanel .deal-vendors'));
  assert.equal(await page.getByLabel('Update', { exact: true }).inputValue(), 'Demo draft remains');
  assert.doesNotMatch(await page.locator('#recordPanel').textContent(), /no vendors|vendor unavailable|not linked/i);
  assert.deepEqual(errors, []);
});

for (const width of [390, 1280]) test(`parked and archived cards retain vendor groups while active list cards stay concise at ${width}px`, async t => {
  const { page, errors } = await open(t, width);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const listCard = page.locator('.deal-list [data-id="d14"]');
  assert.equal(await listCard.locator('.deal-vendor-group').count(), 0,'active list cards contain only checklist items');
  assert.equal(await listCard.evaluate(n => n.scrollWidth <= n.clientWidth), true);
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  assert.equal(await page.locator('.deal-list [data-id="d06"] .deal-vendor-group').count(), 2);
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const deal = { ...state.deals.get('d14'), phase: 'Closed' };
    state.closedDeals = [{ ...deal, outcome: 'won' }];
    state.lostDeals = [{ ...deal, outcome: 'lost' }];
  });
  for (const name of ['Closed deals', 'Lost deals']) {
    await page.getByRole('button', { name, exact: true }).click();
    const card = page.locator('#closedDealsList [data-id="d14"]');
    assert.equal(await card.locator('.deal-vendor-group').count(), 2);
    assert.equal(await card.evaluate(n => n.scrollWidth <= n.clientWidth), true);
    const gap = await card.locator('.deal-vendors').evaluate(n => ({
      roles: parseFloat(getComputedStyle(n).rowGap),
      assignments: parseFloat(getComputedStyle(n.querySelector('ul')).rowGap),
    }));
    assert.ok(gap.roles >= 16 && gap.roles >= 2 * gap.assignments, `${name}: ${JSON.stringify(gap)}`);
  }
  assert.deepEqual(errors, []);
});


for(const width of [390,1280]) test(`six assignments keep Add update on the opening screen at ${width}px`,async t=>{
 const vendors=Array.from({length:6},(_,i)=>({party_id:`demo-six-${i}`,role:i<3?'lender':'landlord_rep',company:{id:`demo-company-${i}`,name:`Demo regional healthcare property and finance company ${i}`},contact:{id:`demo-contact-${i}`,name:`Demo assigned representative number ${i}`}}));
 const {page}=await open(t,width,'dark',vendors);
 await page.locator('.kanban-column [data-id="d14"] .card-open').click();
 const action=page.getByRole('button',{name:'Add update',exact:true});
 await action.waitFor();
 const button=await action.boundingBox(),panel=await page.locator('#recordPanel').boundingBox();
 assert.ok(button.y+button.height<=panel.y+panel.height,JSON.stringify({button,panel}));
 assert.equal(await page.locator('#recordPanel .deal-vendor-company').count(),6);
 assert.equal(await page.locator('#detailUpdateForm').evaluate(n=>Boolean(n.compareDocumentPosition(document.querySelector('#recordPanel .deal-vendors')) & Node.DOCUMENT_POSITION_FOLLOWING)),true);
});


test('role groups have twice the space used within each role',async t=>{
 const {page}=await open(t);
 await page.locator('.kanban-column [data-id="d14"] .card-open').click();
 await page.locator('#detailUpdateForm').waitFor();
 const gap=await page.locator('#recordPanel .deal-vendors').evaluate(n=>({roles:parseFloat(getComputedStyle(n).rowGap),assignments:parseFloat(getComputedStyle(n.querySelector('ul')).rowGap)}));
 assert.ok(gap.roles>=16 && gap.roles>=2*gap.assignments,JSON.stringify(gap));
});
