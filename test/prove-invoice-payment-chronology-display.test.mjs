import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import worker from '../src/worker.js';
import { chromium } from './browser-harness.mjs';
import { invoiceTrackerFixture } from '../js/invoice-tracker-fixture.js';
import { validInvoiceTracker } from '../js/invoice-tracker-model.js';
import { routeContract } from '../js/routes.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile);
const model = await readFile(resolve(root, 'js/invoice-tracker-model.js'), 'utf8');
async function fixture(t, mode = 'pass') {
  let identities = 0;
  const seen = [];
  const server = createServer(async (req, res) => {
    seen.push(req.url);
    if (mode === 'timeout') return;
    try {
      if (req.url === '/app-release') {
        const response = await worker.fetch(new Request('https://fixture.invalid/app-release'), {
          GIT_SHA: (mode === 'release-change' && identities++ ? 'b' : 'a').repeat(40), APP_ENV: 'production',
        });
        res.setHeader('content-type', 'application/json');
        return res.end(mode === 'identity' ? '{}' : await response.text());
      }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const path = resolve(root, '.' + pathname);
      if (!path.startsWith(root + sep) || mode === 'unavailable') { res.writeHead(404); return res.end(); }
      let bytes = await readFile(path);
      if (pathname === '/js/invoice-tracker-model.js') {
        if (mode === 'failure') bytes = model.replace(' || row.received_on < row.commission_invoiced_on', '');
        if (mode === 'foreign') bytes = 'import "https://foreign.invalid/asset.js";';
        if (mode === 'module-cap') bytes = Array.from({length:20},(_,i)=>`import "./extra-${i}.js";`).join('\n');
        if (mode === 'byte-cap') bytes = ' '.repeat(4 * 1024 * 1024 + 1);
      }
      res.setHeader('content-type', 'text/javascript'); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}
async function run(t, mode, timeout = '30000') {
  const { origin, seen } = await fixture(t, mode);
  const args = ['scripts/prove-invoice-payment-chronology-display.mjs', '--origin', origin, '--timeout-ms', timeout];
  try { const out = await exec(process.execPath, args, { cwd: root, timeout: 35000 }); t.diagnostic(`${mode} ${out.stdout.trim()}`); return { code: 0, receipt: JSON.parse(out.stdout), seen }; }
  catch (error) { t.diagnostic(`${mode} exit ${error.code} ${error.stdout.trim()}`); return { code: error.code, receipt: JSON.parse(error.stdout), seen }; }
}
test('chronology CLI proves exact fetched model and real Worker release identity', async t => {
  const { code, receipt, seen } = await run(t, 'pass');
  assert.equal(code, 0, JSON.stringify(receipt));
  assert.equal(receipt.service, 'doctorcre-app'); assert.equal(receipt.environment, 'production');
  assert.equal(receipt.source_commit, 'a'.repeat(40));
  assert.equal(receipt.release.carr_contract.schema, 'doctorcre-carr-interface.v1');
  assert.equal(receipt.assets.find(a=>a.path==='/js/invoice-tracker-model.js').sha256, createHash('sha256').update(model).digest('hex'));
  assert.equal(receipt.assertions.length, 6); assert.ok(receipt.assertions.every(a=>a.passed));
  assert.equal(seen.filter(path=>path==='/app-release').length, 2);
  assert.equal(new Set(seen.filter(path=>path!=='/app-release')).size, receipt.assets.length);
});
test('chronology CLI rejects the merge-base zero-day contradiction', async t => {
  const result = await run(t, 'failure'); assert.equal(result.code, 1);
  assert.equal(result.receipt.assertions.find(a=>a.name==='reversed chronology refused before display').passed, false);
});
for (const mode of ['identity','unavailable','foreign','module-cap','byte-cap','release-change','timeout']) test(`chronology CLI refuses unavailable ${mode}`, async t => {
  const result = await run(t, mode, mode === 'timeout' ? '100' : '30000');
  assert.equal(result.code, 78, JSON.stringify(result.receipt));
  assert.ok(result.receipt.error); assert.ok(result.seen.length <= 22);
});
test('chronology CLI refuses undocumented flags', async () => {
  await assert.rejects(exec(process.execPath, ['scripts/prove-invoice-payment-chronology-display.mjs','--unexpected'], {cwd:root}), e=>e.code===1 && /Usage/.test(e.stdout));
});

for (const width of [390,1440]) test(`chronology unavailable and read-error retries preserve invoice behavior at ${width}px`, async t => {
  const browser = await chromium.launch(); t.after(()=>browser.close());
  const page = await browser.newPage({viewport:{width,height:960}});
  const today='2026-10-02', data=invoiceTrackerFixture(today);
  assert.equal(validInvoiceTracker(data),true);
  const paid=data.entries.find(row=>row.status==='received');
  const validDate=paid.received_on; paid.received_on='2026-03-01';
  let fail=false,writes=0;
  await page.clock.install({time:new Date(today+'T17:00:00Z')});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='http://localhost')return route.abort();
    if(['/api/system-work/session','/auth/session'].includes(url.pathname))return route.fulfill({contentType:'application/json',body:JSON.stringify({csrf_token:'synthetic-session',actor:{slug:'joe',display_name:'Demo Partner'}})});
    if(url.pathname==='/mcp'){
      const req=route.request().postDataJSON().params;
      if(req.name==='record-commission-receipt')writes++;
      if(fail)return route.fulfill({status:503,body:''});
      return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{text:JSON.stringify(data)}]}})});
    }
    const path=resolve(root,routeContract.routes[url.pathname] || '.'+decodeURIComponent(url.pathname));
    if(!path.startsWith(root+sep))return route.fulfill({status:404,body:''});
    try{return route.fulfill({body:await readFile(path),contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto('http://localhost/invoices?mode=live');
  await page.getByText('Invoices unavailable',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-invoice]').count(),0);
  assert.doesNotMatch(await page.locator('#invoiceRows').innerText(),/No invoices/);
  assert.equal(await page.locator('#invoicePayment').isVisible(),false);
  fail=true; await page.locator('#refreshInvoices').click();
  await page.getByText('Invoices unavailable',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-invoice]').count(),0);
  fail=false;
  await page.locator('#refreshInvoices').focus();
  paid.received_on=validDate;
  await page.keyboard.press('Enter'); await page.locator('[data-invoice]').first().waitFor();
  assert.equal(await page.locator('#refreshInvoices').evaluate(n=>n===document.activeElement),true);
  assert.equal(await page.locator('[data-invoice]').count(),6);
  await page.locator('[data-invoice]').first().click();
  paid.received_on='2026-03-01';
  await page.locator('#markInvoicePaid').click();
  await page.getByText('Payment not sent. Current invoice could not be verified.',{exact:true}).waitFor();
  assert.equal(writes,0);
  await page.locator('#closeInvoiceDetail').click();
  paid.received_on=paid.commission_invoiced_on;
  await page.locator('#refreshInvoices').click();
  await page.locator('[data-status="paid"]').click();
  await page.waitForFunction(()=>document.querySelector('.row-age')?.textContent.startsWith('0'));
  await page.locator('[data-invoice]').click();
  assert.match(await page.locator('#invoiceDetailFacts').innerText(),/Days to payment\s+0/);
  assert.equal(await page.getByRole('link',{name:'Open deal',exact:true}).getAttribute('href'),'/deals?deal=demo-invoice-deal-5');
  await page.locator('#closeInvoiceDetail').click();
  assert.equal(await page.locator('[data-invoice]').evaluate(n=>n===document.activeElement),true);
  paid.received_on='2026-03-01';
  await page.locator('#refreshInvoices').click(); await page.getByText('Invoices temporarily unavailable',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-invoice]').count(),1);
  paid.received_on=validDate; fail=true;
  await page.locator('#refreshInvoices').click();
  assert.equal(await page.locator('[data-invoice]').count(),1);
  fail=false;await page.locator('#refreshInvoices').click();
  await page.waitForFunction(()=>document.querySelector('#invoiceNotice').hidden);
  await page.waitForFunction(()=>document.querySelector('.row-age')?.textContent.startsWith('16'));
  assert.equal(writes,0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});
