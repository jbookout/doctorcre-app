import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { identity, found, readiness } from '../../test/fixtures/correspondence.mjs';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';

let server;
test.beforeAll(async () => { server = await startFixtureServer(); });
test.afterAll(async () => { await server?.stop(); });

test('opening a deal replaces the board with a workspace and Back restores its scroll', async ({ page }) => {
  const seed = JSON.parse(await readFile(new URL('../../data/board-seed.json', import.meta.url), 'utf8'));
  seed.deals.push(...Array.from({length:30}, (_, i) => ({...seed.deals.find(deal => deal.id === 'd14'), id:`demo-scroll-${i}`, name:`Demo scroll practice ${i}`, phase:'Research', operating_state:'active', outcome:null, closed_on:null, invoiced_on:null, workspace_kind:'team', account_client_id:null})));
  await page.route('**/data/board-seed.json', route => route.fulfill({json:seed}));
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${server.url}/deals`);
  await page.locator('#listView').click();
  const deal = page.locator('.card-open:visible').last();
  const name = await deal.innerText();
  await page.evaluate(() => document.fonts.ready);
  await deal.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const scroll = await page.evaluate(() => scrollY);
  const boardScroll = await page.locator('#kanban').evaluate(board => ({top:board.scrollTop,left:board.scrollLeft}));
  expect(scroll + boardScroll.top).toBeGreaterThan(0);
  await deal.click();
  await expect(page.getByRole('main', { name: 'Deal Workspace' })).toBeVisible();
  await expect(page.locator('dialog#recordPanel')).toHaveCount(0);
  await expect(page.locator('#panelTitle')).toHaveText(name);
  await expect(page.locator('#main')).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Back to deals' }).click();
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('#listView')).toHaveAttribute('aria-pressed','true');
  await expect.poll(async () => Math.abs((await page.evaluate(() => scrollY)) - scroll)).toBeLessThanOrEqual(1);
  expect(await page.locator('#kanban').evaluate(board => ({top:board.scrollTop,left:board.scrollLeft}))).toEqual(boardScroll);
  await page.goForward();
  await expect(page.getByRole('main', { name: 'Deal Workspace' })).toBeVisible();
  await page.goBack();
  await expect(page.locator('#main')).toBeVisible();
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`workspace tabs show recorded data at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.clock.install({ time: new Date('2026-10-04T17:00:00Z') });
    await page.goto(`${server.url}/deals`);
    await expect(page.locator('.card-open:visible').first()).toBeVisible();
    await page.evaluate(async ({identity,found,readiness}) => {
      const { state } = await import('/js/pipeline.js');
      state.client.correspondenceReadiness = async () => readiness;
      state.client.readCorrespondenceThread = async () => ({ ...found, receipts: [...found.receipts, { ...found.receipts[0], read_receipt_id: '10000000-0000-4000-8000-000000000002', recorded_at: '2026-10-02T15:30:00Z' }] });
      const read = state.client.getDeal.bind(state.client);
      state.client.getDeal = async id => {
        const detail = await read(id);
        return { ...detail,
          deal: { ...detail.deal, name: 'Demo Workspace Practice', client_name: 'Demo Long Client Name Medical Practice Associates', next_step: 'Demo unique next step', next_date: '2026-11-20', phase: 'Legal', owner: 'joe', phase_started_on: { legal: '2026-10-01' } },
          items: [{id:'demo-item',title:'Vendor Introductions',due_on:'2026-02-01',status:'open'}],
          next_actions: [{id:'demo-next',description:'Demo next action',status:'open',due_on:'2026-10-01',hold_until:'2027-01-01'}, ...(window.duplicateNextStep ? [{id:'demo-duplicate',description:'Demo unique next step',status:'open',due_on:'2026-11-20'}] : [])],
          history: [{id:'demo-change',field:'owner',new_value:'dell',recorded_at:'2026-10-02T15:00:00Z',summary:'Demo owner changed'}],
          critical_dates: [{ id: 'demo-loi', kind: 'loi_expiry', due_on: '2026-10-09', note: 'Demo LOI deadline' }],
          thread: [{ id:'demo-old-note', kind:'note', actor:'joe', at:'2026-10-01T12:00:00Z', text:'Demo earlier note' }, { id: 'demo-note', kind: 'note', actor: 'joe', at: '2026-10-02T12:00:00Z', text: 'Demo recorded deal note' }],
          activities: [{id:'demo-mail',kind:'correspondence',source:'Demo mail',occurred_at:'2026-10-01T12:00:00Z',summary:'Demo mail receipt',detail:{native_identity:identity}}, { id: 'demo-earlier', kind: 'meeting', occurred_at: '2026-10-01T12:00:00Z', summary: 'Demo earlier meeting', source: 'Demo calendar fixture' }, { id: 'demo-meeting', kind: 'meeting', occurred_at: '2026-10-03T12:00:00Z', summary: 'Demo discovery meeting', detail: 'Demo meeting evidence', source: 'Demo calendar fixture' }],
          documents: window.workspaceDocumentRemoved ? [] : [{ id: 'demo-document', prepared_at: '2026-10-03T13:00:00Z', note: 'Demo lease document' }],
        };
      };
    }, {identity,found,readiness});
    await page.locator('.card-open:visible').first().click();
    const header = page.locator('.workspace-header');
    await expect(page.locator('#workspaceFacts')).toBeVisible();
    await expect(header).toContainText('Demo Workspace Practice');
    await expect(header).toContainText('Demo Long Client Name Medical Practice Associates');
    await expect(header).toContainText('Legal');
    await expect(header).toContainText('Joe');
    await expect(header).toContainText('Oct 9, 2026');
    await expect(page.getByRole('tab')).toHaveCount(4);
    await expect(page.locator('#workspace-overview')).toBeVisible();
    await expect(page.locator('.critical-dates')).toContainText('LOI');
    await expect(page.locator('#detailUpdateForm')).toBeVisible();
    await expect(page.getByRole('region',{name:'Next actions',exact:true})).toContainText('Demo next action');
    await expect(page.locator('.deal-updates')).toContainText('Demo discovery meeting');
    for (const [tab, label] of [['overview','Overview'], ['timeline','Timeline'], ['correspondence','Correspondence & notes']]) {
      await page.getByRole('tab', { name: label, exact: true }).click();
      await expect(page.locator(`#workspace-${tab}`)).toBeVisible();
      await expect(header).toBeVisible();
      for (const value of ['Demo Long Client Name Medical Practice Associates', 'Legal', 'Joe', 'Oct 9, 2026']) await expect(page.locator('#workspaceFacts').getByText(value, {exact:false}).first()).toBeVisible();
      if (width === 390) {
        const facts = page.locator('#workspaceFacts');
        expect(await facts.evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(48);
        const clip = await header.boundingBox();
        for (const fact of await facts.locator('.workspace-facts > div').all()) {
          const box = await fact.boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(clip.x);
          expect(box.x + box.width).toBeLessThanOrEqual(clip.x + clip.width);
        }
        await expect(facts.locator('dd').first()).toHaveAttribute('title', 'Demo Long Client Name Medical Practice Associates');
        expect(await facts.locator('.workspace-facts').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      if (tab === 'timeline') {
        await expect(page.locator('.phase-rail')).toBeVisible();
        const nextStep = page.locator('.workspace-events li').filter({hasText:'Demo unique next step'});
        await expect(nextStep).toHaveCount(1);
        await expect(nextStep).toContainText('Nov 20, 2026');
        await page.evaluate(() => { window.duplicateNextStep = true; });
        await page.getByRole('button',{name:'Refresh deal',exact:true}).click();
        await expect(nextStep).toHaveCount(1);
        await expect(nextStep).toContainText('Nov 20, 2026');
        await page.evaluate(() => { window.duplicateNextStep = false; });
        await expect(page.locator('.workspace-events li').filter({hasText:'Demo next action'})).toHaveCount(2);
        await expect(page.locator('.workspace-events li').filter({hasText:'Demo next action'})).toContainText(['Jan 1, 2027', 'Oct 1, 2026']);
        for (const text of ['Demo lease document','Demo next action','Demo owner changed','Demo discovery meeting','Demo recorded deal note','Demo LOI deadline','Vendor Introductions']) await expect(page.locator('.workspace-events')).toContainText(text);
        await expect(page.locator('.workspace-events li').filter({hasText:'Vendor Introductions'})).toContainText('Feb 1, 2026');
        await page.getByLabel('Filter by type').selectOption('Document');
        await expect(page.locator('.workspace-events li:visible')).toHaveCount(1);
        await expect(page.locator('.workspace-events li:visible')).toContainText('Demo lease document');
        await page.getByRole('button',{name:'Refresh deal',exact:true}).click();
        await expect(page.getByLabel('Filter by type')).toHaveValue('Document');
        await expect(page.locator('.workspace-events li:visible')).toHaveCount(1);
        await page.evaluate(() => { window.workspaceDocumentRemoved = true; });
        await page.getByRole('button',{name:'Refresh deal',exact:true}).click();
        await expect(page.locator('.workspace-events')).not.toContainText('Demo lease document');
        await expect(page.getByLabel('Filter by type')).toHaveValue('');
        await expect(page.locator('.workspace-events li:visible')).not.toHaveCount(0);
        await page.evaluate(() => { window.workspaceDocumentRemoved = false; });
        await page.getByRole('button',{name:'Refresh deal',exact:true}).click();
        await expect(page.locator('.workspace-events')).toContainText('Demo lease document');
        await expect(page.getByLabel('Filter by type')).toHaveValue('');
      }
      if (tab === 'correspondence') {
        await expect(page.getByRole('region', { name: 'Deal notes', exact: true })).toContainText('Demo recorded deal note');
        await expect(page.locator('#panelEvidence')).toContainText('Demo discovery meeting');
        await expect(page.locator('#panelEvidence')).toContainText('Correspondence thread');
        await expect(page.locator('.workspace-note p')).toHaveText(['Demo recorded deal note', 'Demo earlier note']);
        await expect(page.locator('.workspace-note time')).toHaveText(['Oct 2, 7:00 AM CDT', 'Oct 1, 7:00 AM CDT']);
        await expect(page.locator('[data-evidence-group=threads] time')).toHaveText(['Read Oct 2, 10:30 AM CDT', 'Read Sep 30, 7:00 AM CDT']);
        await expect(page.locator('[data-evidence-group=meetings] time')).toHaveText(['Oct 3, 7:00 AM CDT', 'Oct 1, 7:00 AM CDT']);
        await expect(page.locator('[data-evidence-group=meetings] summary span')).toHaveText(['Demo discovery meeting', 'Demo earlier meeting']);
      }
      await page.evaluate(() => scrollTo(0, 0));
      await page.locator('body').evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390 && tab === 'timeline') {
        const event = page.locator('.workspace-events li:visible').first();
        expect(await event.evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(700);
      }
      const targets = await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => ({ width: tab.getBoundingClientRect().width, height: tab.getBoundingClientRect().height })));
      for (const target of targets) { expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44); }
      const path = testInfo.outputPath(`workspace-${width}-${theme}-${tab}.png`);
      // A full-page capture repeats fixed bars mid-page and hides rows behind them; hide them so every row is visible.
      const chrome = await page.evaluateHandle(() => { const hidden = [...document.querySelectorAll('body *')].filter(el => ['fixed', 'sticky'].includes(getComputedStyle(el).position)); for (const el of hidden) el.style.visibility = 'hidden'; return hidden; });
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await chrome.evaluate(hidden => { for (const el of hidden) el.style.visibility = ''; });
      await testInfo.attach(`${width}-${theme}-${tab}`, { path, contentType: 'image/png' });
    }
  });
}

test('a direct deal link opens Overview and Back reaches the board', async ({ page }) => {
  await page.goto(`${server.url}/deals?deal=d14`);
  await expect(page.getByRole('main', { name: 'Deal Workspace' })).toBeVisible();
  await expect(page.locator('#panelTitle')).toHaveText('Demo Surgical Practice');
  await expect(page.locator('#workspace-overview')).toBeVisible();
  await page.getByRole('button', { name: 'Back to deals' }).click();
  await expect(page.locator('#main')).toBeVisible();
  await expect(page).not.toHaveURL(/deal=/);
});

test('header distinguishes overdue dates from missing dates', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-04T17:00:00Z') });
  await page.goto(`${server.url}/deals`);
  await expect(page.locator('.card-open:visible').first()).toBeVisible();
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const read = state.client.getDeal.bind(state.client);
    state.client.getDeal = async id => {
      const detail = await read(id);
      return {...detail, critical_dates: window.noDates ? [] : [{id:'old',kind:'loi_expiry',due_on:'2020-01-01'}], deal:{...detail.deal, phase_started_on:{}}};
    };
  });
  await page.locator('.card-open:visible').first().click();
  await expect(page.locator('#workspaceFacts')).toContainText('Jan 1, 2020');
  await expect(page.locator('#workspaceFacts')).toContainText('overdue');
  await page.evaluate(() => { window.noDates = true; });
  await page.getByRole('button',{name:'Refresh deal'}).click();
  await expect(page.locator('#workspaceFacts')).toContainText('Not recorded');
});
