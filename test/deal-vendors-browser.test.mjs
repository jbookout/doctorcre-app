import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, waitForAsync } from './browser-harness.mjs';

const root = new URL('../', import.meta.url);
const assignments = [
  { party_id: 'demo-v1', role: 'lender', company: { id: 'demo-c1', name: 'Demo Bank & Trust' }, contact: { id: 'demo-p1', name: 'Demo Contact <One>', email: 'demo.long.assigned.representative@example.invalid', phone: '+1 (555) 010-0101 <desk>' } },
  { party_id: 'demo-v2', role: 'landlord_rep', company: { id: 'demo-c2', name: 'Demo Property Group' }, contact: { id: 'demo-p2', name: 'Demo Contact Two' } },
  { party_id: 'demo-v3', role: 'lender', company: { id: 'demo-c3', name: 'Demo Second Bank' }, contact: { id: 'demo-p3', name: 'Demo Contact Three', email: null, phone: '+1 (555) 010-0103' } },
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
  assert.equal(await card.locator('.deal-vendor-group').count(), 2);
  assert.deepEqual(await card.locator('.deal-vendor-role').allTextContents(), ['Lender', 'Landlord rep']);
  assert.deepEqual(await card.locator('.deal-vendor-company').allTextContents(), ['Demo Bank & Trust', 'Demo Second Bank', 'Demo Property Group']);
  assert.deepEqual(await card.locator('.deal-vendor-contact').allTextContents(), ['Demo Contact <One>', 'Demo Contact Three', 'Demo Contact Two']);
  assert.equal(await card.locator('.deal-vendor-contact one').count(), 0);
  const contact = card.locator('.deal-vendor-details').first();
  assert.equal(await card.locator('.deal-vendor-details').count(), 2, 'contacts without channels do not add empty disclosures');
  assert.equal(await contact.evaluate(n => n.open), false);
  const disclosure = contact.locator('summary');
  await disclosure.click();
  assert.equal(await contact.getByText('demo.long.assigned.representative@example.invalid', { exact: true }).isVisible(), true);
  assert.equal(await contact.getByText('+1 (555) 010-0101 <desk>', { exact: true }).isVisible(), true);
  assert.equal(await contact.locator('desk').count(), 0, 'contact channels remain escaped text');
  assert.equal(await page.locator('#recordPanel').isVisible(), false, 'opening contact details does not open the deal');
  await disclosure.press('Space');
  assert.equal(await contact.evaluate(n => n.open), false);
  await disclosure.press('Enter');
  assert.equal(await contact.evaluate(n => n.open), true);
  assert.equal(await page.locator('#recordPanel').isVisible(), false);
  const phoneOnly = card.locator('.deal-vendor-details').nth(1);
  await phoneOnly.locator('summary').click();
  assert.equal(await phoneOnly.getByText('+1 (555) 010-0103', { exact: true }).isVisible(), true);
  assert.doesNotMatch(await phoneOnly.textContent(), /Email/);
  const target = await disclosure.boundingBox();
  assert.ok(target.width >= 44 && target.height >= 44, JSON.stringify(target));
  assert.equal(await page.locator('.kanban-column [data-id="d05"] .deal-vendors').count(), 0);
  await card.scrollIntoViewIfNeeded();
  assert.equal(await card.evaluate(n => n.scrollWidth <= n.clientWidth), true);
  await page.screenshot({ path: new URL(`${width}-${theme}-board.png`, evidence).pathname, animations: 'disabled' });
  await card.locator('.card-open').click();
  await page.locator('#detailUpdateForm').waitFor();
  assert.equal(await page.locator('#recordPanel .deal-vendor-group').count(), 2);
  const detailContact = page.locator('#recordPanel .deal-vendor-details').first();
  await detailContact.locator('summary').click();
  assert.equal(await detailContact.getByText('demo.long.assigned.representative@example.invalid', { exact: true }).isVisible(), true);
  assert.equal(await detailContact.getByText('+1 (555) 010-0101 <desk>', { exact: true }).isVisible(), true);
  await detailContact.scrollIntoViewIfNeeded();
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

for (const width of [390, 1280]) test(`list, parked and archived cards retain vendor groups at ${width}px`, async t => {
  const { page, errors } = await open(t, width);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const listCard = page.locator('.deal-list [data-id="d14"]');
  assert.equal(await listCard.locator('.deal-vendor-group').count(), 2);
  await listCard.locator('.deal-vendor-details summary').first().click();
  assert.equal(await listCard.getByText('demo.long.assigned.representative@example.invalid', { exact: true }).isVisible(), true);
  assert.equal(await page.locator('#recordPanel').isVisible(), false);
  assert.equal(await listCard.evaluate(n => n.scrollWidth <= n.clientWidth), true);
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  assert.equal(await page.locator('.deal-list [data-id="d06"] .deal-vendor-group').count(), 2);
  await page.locator('.deal-list [data-id="d06"] .deal-vendor-details summary').first().click();
  assert.equal(await page.locator('.deal-list [data-id="d06"]').getByText('demo.long.assigned.representative@example.invalid', { exact: true }).isVisible(), true);
  assert.equal(await page.locator('#recordPanel').isVisible(), false);
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
    await card.locator('.deal-vendor-details summary').first().click();
    assert.equal(await card.getByText('demo.long.assigned.representative@example.invalid', { exact: true }).isVisible(), true);
    assert.equal(await card.evaluate(n => n.scrollWidth <= n.clientWidth), true);
    const gap = await card.locator('.deal-vendors').evaluate(n => ({
      roles: parseFloat(getComputedStyle(n).rowGap),
      assignments: parseFloat(getComputedStyle(n.querySelector('ul')).rowGap),
    }));
    assert.ok(gap.roles >= 16 && gap.roles >= 2 * gap.assignments, `${name}: ${JSON.stringify(gap)}`);
  }
  assert.deepEqual(errors, []);
});


test('parked Board cards still open by body click, Enter and Space around vendor disclosures', async t => {
  const { page } = await open(t);
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  const card = page.locator('.parked-lane [data-id="d06"]');
  await card.locator('.deal-vendor-details summary').first().click();
  assert.equal(await card.getByText('demo.long.assigned.representative@example.invalid', { exact: true }).isVisible(), true);
  assert.equal(await page.locator('#recordPanel').isVisible(), false);
  for (const action of ['click', 'Enter', 'Space']) {
    if (action === 'click') await card.locator('h4').click();
    else await card.press(action);
    await page.locator('#detailUpdateForm').waitFor();
    assert.equal(await page.locator('#recordPanel').isVisible(), true, action);
    await page.getByRole('button', { name: 'Close deal', exact: true }).click();
  }
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
 const gap=await page.locator('.kanban-column [data-id="d14"] .deal-vendors').evaluate(n=>({roles:parseFloat(getComputedStyle(n).rowGap),assignments:parseFloat(getComputedStyle(n.querySelector('ul')).rowGap)}));
 assert.ok(gap.roles>=16 && gap.roles>=2*gap.assignments,JSON.stringify(gap));
});

for (const theme of ['dark', 'light']) test(`vendor contacts are distinct and actionable on phones in ${theme}`, async t => {
  const vendors = [
    { role: 'lender', company: { name: 'Demo Firm' }, contact: { name: 'Demo Person', email: 'person@example.invalid', phone: '+1 (555) 010-1234' } },
    { role: ' LENDER ', company: { name: ' demo firm ' }, contact: { name: ' demo person ' } },
    { role: 'advisor', company: { name: 'Demo Firm' }, contact: { name: 'Demo Person' } },
    { role: 'advisor', company: { name: 'Demo Other' }, contact: { name: null } },
    { role: 'advisor', company: null, contact: { name: 'Demo Solo' } },
  ];
  const { page } = await open(t, 390, theme, vendors);
  const card = page.locator('.kanban-column [data-id="d14"]');
  assert.equal(await card.getByText('Demo Person', { exact: true }).count(), 2);
  assert.equal(await card.getByText('Demo Other', { exact: true }).count(), 1);
  assert.equal(await card.getByText('Demo Solo', { exact: true }).count(), 1);
  assert.doesNotMatch(await card.locator('.deal-vendors').textContent(), /undefined|null/);
  await card.locator('.deal-vendor-details summary').click();
  for (const [name, href] of [['person@example.invalid', 'mailto:person@example.invalid'], ['+1 (555) 010-1234', 'tel:+15550101234']]) {
    const action = card.getByRole('link', { name, exact: true });
    assert.equal(await action.count(), 1, `accessible name includes ${name}`);
    assert.equal(await action.getAttribute('href'), href);
    const box = await action.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, JSON.stringify(box));
  }
  assert.equal(await card.evaluate(n => n.scrollWidth <= n.clientWidth), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
});

for (const theme of ['dark', 'light']) test(`merged vendor contact rows fit and read as actions at 390px in ${theme}`, async t => {
  const vendors = [
    { role: 'lender', company: { name: 'Demo Firm' }, contact: { name: 'Demo Person' } },
    { role: 'lender', company: { name: 'Demo Firm' }, contact: { name: 'Demo Person', email: 'demo.long.assigned.representative@example.test', phone: '555-010-1234 x12' } },
  ];
  const { page } = await open(t, 390, theme, vendors);
  const card = page.locator('.kanban-column [data-id="d14"]');
  assert.equal(await card.locator('.deal-vendor-company').count(), 1);
  await card.locator('summary').click();
  const rows = card.locator('.deal-vendor-details p');
  assert.equal(await rows.count(), 2);
  for (const row of await rows.all()) {
    const link = row.locator('a');
    const [labelBox, linkBox] = await Promise.all([row.evaluate(n => { const range = document.createRange(); range.selectNodeContents(n.firstChild); const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, height: r.height }; }), link.boundingBox()]);
    assert.ok(labelBox && linkBox && Math.abs(labelBox.y + labelBox.height / 2 - linkBox.y - linkBox.height / 2) < 5, JSON.stringify({ labelBox, linkBox }));
    assert.ok(await link.evaluate(n => getComputedStyle(n).textDecorationLine.includes('underline')));
  }
  assert.equal(await card.evaluate(n => n.scrollWidth <= n.clientWidth), true);
  const evidence = new URL('out/test-artifacts/deal-vendors/', root);
  await mkdir(evidence, { recursive: true });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL(`390-${theme}-dedupe.png`, evidence).pathname, animations: 'disabled' });
});
