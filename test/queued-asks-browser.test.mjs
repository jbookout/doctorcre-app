import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { readFile } from 'node:fs/promises';
const conversation='0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01';
for (const width of [390,1280]) for (const theme of ['light','dark']) {
  test(`queued ask keyboard flow at ${width} ${theme}`, async t => {
    const server=await fixtureServer();t.after(()=>server.close());
    const browser=await chromium.launch();t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width,height:900},colorScheme:theme});
    await page.goto(`${server.origin}/conversations?id=${conversation}`);
    const input=page.getByRole('textbox',{name:'Ask Dr. CRE',exact:true}); await input.waitFor();
    await page.context().setOffline(true);
    await input.fill('Please prepare the synthetic lease comparison.');
    await input.press('Tab'); await page.getByRole('button',{name:'Send ask',exact:true}).press('Enter');
    await page.getByText('Saved on this device. Waiting for a connection.',{exact:true}).waitFor();
    await page.context().setOffline(false);
    await page.getByText('Received by Dr. CRE. An answer is still pending.',{exact:true}).waitFor();
    assert.equal(await page.locator('#askText').inputValue(),'');
    await input.fill('A newer draft'); await page.reload();
    await page.getByRole('textbox',{name:'Ask Dr. CRE',exact:true}).waitFor();
    assert.equal(await page.locator('#askText').inputValue(),'A newer draft');
    await page.getByText('Received by Dr. CRE. An answer is still pending.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.addScriptTag({content:await readFile(new URL('../node_modules/axe-core/axe.min.js',import.meta.url),'utf8')});
    const violations=await page.evaluate(async()=> (await window.axe.run(document.querySelector('#askComposer'))).violations);
    assert.deepEqual(violations.map(v=>v.id),[]);
  });
}
