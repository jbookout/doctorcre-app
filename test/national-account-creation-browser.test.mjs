import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

test('national creation reviews duplicate candidates and existing sub-clients through real forms', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:390,height:844}});
  // Keep board reads synthetic; exercise the real live writer at the form seam.
  const source = await readFile(new URL('../js/client.js',import.meta.url),'utf8');
  await page.route('**/js/client.js', route => route.fulfill({contentType:'text/javascript',body:`${source}
    const fixtureCreateClient = createClient;
    createClient = async (...args) => {
      const client = await fixtureCreateClient(...args);
      const {createLiveClient} = await import('./live-client.js');
      const live = createLiveClient({docContext:false});
      client.createNationalAccount = live.createNationalAccount;
      client.createNationalMarketDeal = live.createNationalMarketDeal;
      return client;
    };`}));
  const sent = [], errors = [];
  page.on('pageerror',error => errors.push(error.message));
  await page.route('**/auth/session',route => route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}}));
  await page.route('**/api/**',route => route.fulfill({json:{}}));
  await page.route('**/mcp',async route => {
    const {name,arguments:args} = route.request().postDataJSON().params;
    sent.push({name,args});
    const payload = name === 'create-national-account'
      ? args.force_new ? {ok:true,account_client_id:'demo-created-account'}
        : {needs_confirm:true,candidates:[{id:'demo-existing-org',name:'Demo Existing Brand'}]}
      : args.client_name === 'Demo Existing' ? {ok:true,deal_id:'demo-created-deal',account_client_id:args.account_client_id}
        : {ok:false,error:'research_evidence_required'};
    await route.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(payload)}]}}});
  });
  await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
  await page.locator('.account-card').first().waitFor();
  await page.getByRole('button',{name:'Workspace sidebar',exact:true}).click();
  await page.locator('#stickyAddButton').click();
  await page.locator('#accountName').fill('Demo Separate Brand');
  await page.locator('#dialogSubmit').click();
  assert.equal(sent.length,0,'native validation blocks absent research');
  for (const field of ['name','company','phone','specialty','market']) await page.locator(`[name="research_${field}"]`).fill(`https://example.com/demo/${field}`);
  await page.locator('[name="research_observed_at"]').fill('2026-10-22T10:00');
  await page.locator('#dialogSubmit').click();
  await page.getByText('Demo Existing Brand (demo-existing-org)').waitFor();
  assert.equal(await page.locator('#formDialog').isVisible(),true);
  await page.locator('#dialogSubmit').click(); assert.equal(sent.length,1);
  await page.locator('[name="confirm_separate"]').check();
  await page.locator('#dialogSubmit').click();
  await page.locator('#formDialog').waitFor({state:'hidden'});
  assert.equal(sent[1].args.force_new,true);
  assert.notEqual(sent[1].args.idempotency_key,sent[0].args.idempotency_key);
  assert.deepEqual(sent[1].args.research_evidence,sent[0].args.research_evidence);

  await page.keyboard.press('Escape');
  await page.locator('.account-card').first().click();
  await page.getByRole('button',{name:'Workspace sidebar',exact:true}).click();
  await page.locator('#stickyAddButton').click();
  await page.locator('#marketClientMode').selectOption('existing');
  assert.equal(await page.locator('#marketResearch').isVisible(),false);
  await page.locator('#marketClient').fill('Demo Unmatched');
  await page.locator('#marketDealName').fill('Demo Market Transaction');
  await page.locator('#marketCity').fill('Demo City');
  await page.locator('#dialogSubmit').click();
  await page.locator('#formError').waitFor();
  assert.match(await page.locator('#formError').textContent(),/Research evidence is required/);
  assert.equal(await page.locator('#formDialog').isVisible(),true);
  await page.locator('#marketClient').fill('Demo Existing');
  await page.locator('#dialogSubmit').click();
  await page.locator('#formDialog').waitFor({state:'hidden'});
  assert.equal(Object.hasOwn(sent.at(-1).args,'research_evidence'),false);
  assert.equal(Object.hasOwn(sent.at(-1).args,'client_mode'),false);
  assert.deepEqual(errors,[]);
});
