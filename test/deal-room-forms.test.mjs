import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`Deal Room forms preserve fields and recovery at ${width}px in ${theme}`, async t => {
    const server = await fixtureServer(); t.after(() => server.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
    await page.route('**/js/app.js', route => route.fulfill({ contentType: 'text/javascript', body: source + `
      globalThis.formsApp = {state,nextStepForm,parkDealForm,marketAgentForm,addTeamDealForm,addAccountForm,addMarketDealForm,accountOwnerForm,showConflict};` }));
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
    await page.locator('.account-card').first().click();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const directory = process.env.DEAL_ROOM_FORMS_EVIDENCE || '/tmp/wr616-s4-j10-shots'; await mkdir(directory, { recursive: true });
    const expected = {
      nextStepForm: ['text', 'next_date'], parkDealForm: ['reason', 'note'], marketAgentForm: ['agent_name', 'market'],
      addTeamDealForm: ['client', 'name', 'deal_type', 'phase', 'market', 'segment'],
      addAccountForm: ['name', 'owner', 'vertical', 'research_name', 'research_company', 'research_phone', 'research_specialty', 'research_market', 'research_observed_at', 'research_discrepancies'],
      addMarketDealForm: ['client_mode', 'client_name', 'deal_name', 'market', 'state', 'agent_name', 'segment', 'research_name', 'research_company', 'research_phone', 'research_specialty', 'research_market', 'research_observed_at', 'research_discrepancies'],
      accountOwnerForm: ['owner'], showConflict: ['winner', 'winner'],
    };
    for (const [method, fields] of Object.entries(expected)) {
      await page.evaluate(method => {
        const app = window.formsApp;
        const deal = [...app.state.deals.values()].find(row => row.account_client_id === app.state.accountId);
        if (method === 'showConflict') app.showConflict({ conflict_id:'synthetic-conflict', field:'attention', a:{actor:'dell', value:true}, b:{actor:'joe',value:false} });
        else app[method](deal.id);
      }, method);
      assert.deepEqual(await page.locator('#dialogBody [name]').evaluateAll(nodes => nodes.map(node => node.name)), fields);
      await page.waitForFunction(() => document.querySelector('#dialogBody').contains(document.activeElement));
      assert.equal(await page.locator('#dialogForm').evaluate(form => form.checkValidity()), method === 'parkDealForm' || method === 'marketAgentForm' || method === 'accountOwnerForm' || method === 'nextStepForm');
      if (method === 'showConflict') {
        assert.equal(await page.locator('[name=winner]:checked').count(), 0);
        assert.match(await page.locator('#dialogBody').textContent(), /Previously recorded value.*Dell: Flagged.*Your proposed value.*Joe: Not flagged/s);
      }
      if (method === 'addMarketDealForm') {
        await page.locator('#marketClientMode').selectOption('existing');
        assert.equal(await page.locator('#marketResearch').isHidden(), true);
        assert.equal(await page.locator('#research_name').isDisabled(), true);
        await page.locator('#marketClientMode').selectOption('new');
        assert.equal(await page.locator('#research_name').isDisabled(), false);
      }
      await page.screenshot({ path: `${directory}/${method}-${width}-${theme}.png`, fullPage: true });
      await page.keyboard.press('Escape');
    }
    await page.evaluate(() => {
      const app = window.formsApp;
      const deal = [...app.state.deals.values()].find(row => row.account_client_id === app.state.accountId);
      window.formDeal = deal;
      window.formRequests = [];
      app.state.client.getDeal = async () => ({deal});
      app.state.client.setNextStep = async request => {
        window.formRequests.push(structuredClone(request));
        if (window.formRequests.length === 1) throw new Error('Synthetic unanswered write');
        if (window.formRequests.length === 2) throw Object.assign(new Error('Synthetic refusal'), {status:400, payload:{error:'invalid_argument',hint:'Synthetic refusal'}});
        return {ok:true};
      };
      app.nextStepForm(deal.id);
    });
    await page.locator('#stepText').fill('Synthetic recovery step');
    await page.locator('#stepDate').fill('2026-11-04');
    await page.locator('#dialogSubmit').click();
    await page.waitForFunction(() => document.querySelector('#stepText').disabled);
    assert.equal(await page.locator('#dialogSubmit').textContent(), 'Check outcome');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.formsApp.nextStepForm(window.formDeal.id));
    assert.equal(await page.locator('#stepText').inputValue(), 'Synthetic recovery step');
    assert.equal(await page.locator('#stepText').isDisabled(), true);
    await page.locator('#dialogSubmit').click();
    await page.waitForFunction(() => !document.querySelector('#stepText').disabled);
    assert.equal(await page.locator('#formDialog').isVisible(), true);
    assert.match(await page.locator('#formError').textContent(), /Synthetic refusal/);
    const requests = await page.evaluate(() => window.formRequests);
    assert.deepEqual(requests[1], requests[0]);
    await page.locator('#stepText').fill('Synthetic corrected step');
    await page.locator('#dialogSubmit').click();
    await page.locator('#formDialog').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.formRequests[2].text), 'Synthetic corrected step');
    assert.deepEqual(errors, []);
  });
}
