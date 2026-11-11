import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { filterAssertions } from '../scripts/prove-historical-fit-deal-type-filter.mjs';
for(const width of [390,1280]) for(const colorScheme of ['light','dark']) {
  test(`deal type transitions and invariants at ${width} ${colorScheme}`,async t=>{
    const server=await startFixtureServer();t.after(()=>server.stop());
    const browser=await chromium.launch();t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width,height:900},colorScheme});
    await page.route(`${server.url}/__filter`,r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Filter</title>'}));
    await page.goto(`${server.url}/__filter`);
    assert.equal((await filterAssertions(page,`${server.url}/js/ui-ideal-client-profile.js`)).length,10);
  });
}

for (const choice of ['recorded', 'Unrecorded']) for (const action of ['retirement', 'disposal']) {
  test(`ready ${choice} selection ${action} removes evidence and prevents further reads`, async t => {
    const { recordings } = await import('../scripts/prove-historical-fit-deal-type-filter.mjs');
    const recorded = await recordings();
    const server = await startFixtureServer(); t.after(() => server.stop());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route(`${server.url}/__filter`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Filter lifecycle</title>' }));
    await page.goto(`${server.url}/__filter`);
    await page.evaluate(async ({ moduleURL, payload }) => {
      const { mountIdealClientProfile } = await import(moduleURL);
      const host = document.createElement('main'); document.body.replaceChildren(host);
      const proof = window.readySelectionProof = { reads: 0 };
      proof.mount = mountIdealClientProfile(host, { getIdealClientProfile() {
        proof.reads++;
        return Promise.resolve(structuredClone(payload));
      } });
    }, { moduleURL: `${server.url}/js/ui-ideal-client-profile.js`, payload: recorded.full });
    const host = page.locator('main');
    await host.locator('summary').first().click();
    const selector = host.getByLabel('Deal type', { exact: true });
    await selector.waitFor();
    const selectedType = choice === 'Unrecorded' ? null : 'lease';
    await selector.selectOption(JSON.stringify(selectedType));
    assert.equal(await selector.inputValue(), JSON.stringify(selectedType));
    assert.equal(await host.locator('tbody tr').count(), 1);
    assert.equal(await page.evaluate(() => window.readySelectionProof.reads), 1);
    await page.evaluate(action => {
      const proof = window.readySelectionProof;
      proof.controls = [...document.querySelectorAll('main button, main select, main summary, main form')];
      if (action === 'retirement') window.dispatchEvent(new Event('doctorcre-session-invalidated'));
      else proof.mount.dispose();
    }, action);
    assert.equal(await host.locator('tbody tr').count(), 0, 'ready selection evidence is evicted immediately');
    assert.equal(await selector.count(), 0, 'ready selection control is removed immediately');
    if (action === 'retirement') assert.match(await host.getByRole('status').innerText(), /Sign in again/);
    await page.evaluate(async () => {
      const proof = window.readySelectionProof;
      proof.mount.clear();
      for (const control of proof.controls) {
        if (control instanceof HTMLButtonElement) control.click();
        if (control instanceof HTMLSelectElement) control.dispatchEvent(new Event('change', { bubbles: true }));
        if (control instanceof HTMLElement && control.tagName === 'SUMMARY') control.click();
        if (control instanceof HTMLFormElement) control.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(await page.evaluate(() => window.readySelectionProof.reads), 1, 'retired controls and clear cannot read history again');
    assert.equal(await host.locator('tbody tr').count(), 0);
    assert.equal(await selector.count(), 0);
  });
}
