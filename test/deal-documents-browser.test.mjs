import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import {buildArtifact} from '../scripts/artifact.mjs';
import {temporaryDirectory} from '../scripts/temp-directory.mjs';
import {copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import axe from 'axe-core';

test('documents_picker_roundtrip_and_pending_draft_survive_reload',async t=>{
 const server=await startFixtureServer();t.after(()=>server.stop());
 const browser=await chromium.launch();t.after(()=>browser.close());
 for(const width of [320,390])await t.test(`${width}px`,async()=>{
  const page=await browser.newPage({viewport:{width,height:900}});
  try {
   await page.goto(`${server.url}/share-to-deal`);
   await page.getByLabel('Choose files',{exact:true}).setInputFiles({name:'Demo LOI.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7 synthetic')});
   await page.getByText('Demo LOI.pdf',{exact:false}).waitFor();
   await page.reload();
   await page.getByText('Demo LOI.pdf',{exact:false}).waitFor();
   const picker=page.getByRole('combobox',{name:'Deal',exact:true});
   const value=await picker.locator('option').nth(1).getAttribute('value');await picker.selectOption(value);
   await page.getByRole('button',{name:'File documents',exact:true}).click();
   await page.getByText('Documents filed and confirmed by the deal document list.',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   const empty=await page.evaluate(async()=>{const request=indexedDB.open('doctorcre-incoming-deal-share-v1',1);const db=await new Promise(resolve=>request.onsuccess=()=>resolve(request.result));return new Promise(resolve=>{const tx=db.transaction('draft');const read=tx.objectStore('draft').get('pending');read.onsuccess=()=>{resolve(!read.result);db.close();};});});
   assert.equal(empty,true);
  }finally{await page.close();}
 });
});

test('installed_POST_stages_in_IDB_only_and_session_revocation_purges_bound_draft',async t=>{
 const artifact=await temporaryDirectory('doctorcre-share-target-',t);
 await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:artifact,commit:'1'.repeat(40)});
 await copyFile('public-shell/sw.js',`${artifact}/site/sw.js`);
 await copyFile('public-shell/offline.html',`${artifact}/site/offline.html`);
 const server=await startFixtureServer({env:{DOCTORCRE_FIXTURE_ROOT:`${artifact}/site`}});t.after(()=>server.stop());
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());
 await page.goto(`${server.url}/share-to-deal`);
 await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');});
 await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 const result=await page.evaluate(async()=>{const form=new FormData();form.append('files',new File(['%PDF-synthetic'],'Demo share.pdf',{type:'application/pdf'}));const response=await fetch('/share-to-deal',{method:'POST',body:form});return {status:response.status,url:response.url};});
 assert.equal(result.status,200);assert.match(result.url,/share-to-deal\?draft=/);
 await page.goto(result.url);await page.getByText('Demo share.pdf',{exact:false}).waitFor();
 assert.equal(await page.getByRole('combobox',{name:'Deal'}).inputValue(),'');
 const noPrivateCache=await page.evaluate(async()=>{for(const key of await caches.keys()){const cache=await caches.open(key);for(const request of await cache.keys())if(new URL(request.url).pathname==='/share-to-deal')return false;}return true;});assert.equal(noPrivateCache,true);
 await page.evaluate(()=>window.dispatchEvent(new Event('doctorcre-session-invalidated')));
 await page.getByText('Session ended. Pending files removed.',{exact:true}).waitFor();
 await page.reload();await page.getByLabel('Choose files',{exact:true}).waitFor();
});

test('workspace_documents_tab_uses_canonical_list_and_safe_filename',async t=>{
 const server=await startFixtureServer();t.after(()=>server.stop());
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());
 await page.goto(`${server.url}/deals?deal=d14&tab=documents`);
 await page.getByRole('tab',{name:'Documents',exact:true}).waitFor();
 await page.getByLabel('Upload documents',{exact:true}).waitFor();
 await page.getByLabel('Upload documents',{exact:true}).setInputFiles({name:'<img src=x onerror=alert(1)>.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-synthetic')});
 await page.getByText('<img src=x onerror=alert(1)>.pdf',{exact:false}).waitFor();
 assert.equal(await page.locator('img[src=x]').count(),0);
 await page.getByRole('button',{name:'Cancel pending files',exact:true}).click();await page.getByText('Pending files cancelled.',{exact:true}).waitFor();
});

test('quota_error_preserves_recoverable_ui',async t=>{
 const server=await startFixtureServer();t.after(()=>server.stop());const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());
 await page.goto(`${server.url}/share-to-deal`);
 await page.evaluate(()=>{globalThis.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw new DOMException('Synthetic quota denied','QuotaExceededError');};});
 await page.getByLabel('Choose files',{exact:true}).setInputFiles({name:'Demo quota.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-synthetic')});
 await page.getByText('Files were not staged.',{exact:false}).waitFor();
 assert.equal(await page.getByLabel('Choose files',{exact:true}).isEnabled(),true);
 await page.evaluate(()=>{IDBObjectStore.prototype.put=globalThis.originalPut;});
 await page.getByLabel('Choose files',{exact:true}).setInputFiles({name:'Demo quota.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-synthetic')});
 await page.getByText('Demo quota.pdf',{exact:false}).waitFor();
});

test('all_draft_eviction_paths',async t=>{
 const server=await startFixtureServer();t.after(()=>server.stop());const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());
 await page.goto(`${server.url}/share-to-deal`);
 const stage=async()=>{await page.getByLabel('Choose files',{exact:true}).setInputFiles({name:'Demo expiry.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-synthetic')});await page.getByText('Demo expiry.pdf',{exact:false}).waitFor();};
 await stage();await page.getByRole('button',{name:'Cancel pending files',exact:true}).click();await page.getByText('Pending files cancelled.',{exact:true}).waitFor();await page.reload();await page.getByLabel('Choose files',{exact:true}).waitFor();
 await stage();
 await page.evaluate(async()=>{const request=indexedDB.open('doctorcre-incoming-deal-share-v1',1);const db=await new Promise(resolve=>request.onsuccess=()=>resolve(request.result));await new Promise(resolve=>{const tx=db.transaction('draft','readwrite'),store=tx.objectStore('draft'),read=store.get('pending');read.onsuccess=()=>store.put({...read.result,created_at:Date.now()-86400001},'pending');tx.oncomplete=resolve;});db.close();});
 await page.reload();await page.getByLabel('Choose files',{exact:true}).waitFor();
 await stage();await page.evaluate(()=>window.dispatchEvent(new Event('doctorcre-session-invalidated')));await page.reload();await page.getByLabel('Choose files',{exact:true}).waitFor();
});

test('offline_resume_without_duplicate_filing',async t=>{
 const server=await startFixtureServer();t.after(()=>server.stop());const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());
 await page.goto(`${server.url}/share-to-deal`);await page.getByLabel('Choose files',{exact:true}).setInputFiles({name:'Demo offline.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-synthetic')});
 const picker=page.getByRole('combobox',{name:'Deal'});await picker.selectOption(await picker.locator('option').nth(1).getAttribute('value'));
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='File documents' && !button.disabled));
 await page.context().setOffline(true);await page.getByText('Offline. Pending files remain on this device.',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'File documents',exact:true}).isDisabled(),true);
 await page.context().setOffline(false);await page.getByText('Reconnected.',{exact:false}).waitFor();
 assert.equal(await page.getByText('Filed and confirmed',{exact:true}).count(),0);
 await page.getByRole('button',{name:'File documents',exact:true}).click();await page.getByText('Documents filed and confirmed by the deal document list.',{exact:true}).waitFor();
});

test('10x_deals_use_existing_paging',async t=>{
 const server=await startFixtureServer();t.after(()=>server.stop());const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());
 await page.goto(`${server.url}/public-shell/offline.html`);
 await page.evaluate(async()=>{const {mountShareToDeal}=await import('/js/ui-share-to-deal.js');const host=document.createElement('div');document.body.replaceChildren(host);await mountShareToDeal(host,{getBoard:async()=>({actor:'joe',deals:Array.from({length:250},(_,i)=>({id:`demo-${i}`,name:`Demo deal ${i}`}))})});});
 await page.getByLabel('Choose files',{exact:true}).setInputFiles({name:'Demo paging.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-synthetic')});
 const picker=page.getByRole('combobox',{name:'Deal'});await picker.waitFor();assert.equal(await picker.locator('option').count(),26);
 await page.getByRole('button',{name:'More deals',exact:true}).click();assert.equal(await picker.locator('option').nth(1).getAttribute('value'),'demo-25');
 await picker.selectOption('demo-25');
 await page.waitForFunction(()=>document.querySelector('select').value==='demo-25');
});

test('keyboard_and_accessibility_on_share_surface',async t=>{
 const server=await startFixtureServer();t.after(()=>server.stop());const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());
 await page.goto(`${server.url}/share-to-deal`);await page.getByLabel('Choose files',{exact:true}).waitFor();
 await page.addScriptTag({content:axe.source});
 const violations=await page.evaluate(async()=>{const result=await axe.run(document.querySelector('[data-share-to-deal]'));return result.violations.map(row=>row.id);});assert.deepEqual(violations,[]);
 await page.getByLabel('Choose files',{exact:true}).focus();assert.equal(await page.getByLabel('Choose files',{exact:true}).evaluate(node=>node===document.activeElement),true);
});

test('initial_sign_in_preserves_unbound_share_but_logout_purges_without_controller',async t=>{
 const server=await startFixtureServer();t.after(()=>server.stop());const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());
 await page.goto(`${server.url}/share-to-deal`);
 const result=await page.evaluate(async()=>{const {draftStore,stageFiles}=await import('/js/ui-share-store.js');const {clearPrivateStorage}=await import('/js/offline-tour-session.js');const store=draftStore();const draft=await stageFiles([new File(['%PDF-synthetic'],'Demo sign-in.pdf')]);await store.save(draft,true);await clearPrivateStorage(window,{preserveUnboundShare:true});const preserved=!!await store.read();await clearPrivateStorage(window);const purged=!await store.read();return {preserved,purged,controller:!!navigator.serviceWorker.controller};});
 assert.deepEqual(result,{preserved:true,purged:true,controller:false});
});

test('action_and_resume_caps',async t=>{
 const server=await startFixtureServer();t.after(()=>server.stop());const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());
 await page.clock.install();await page.goto(`${server.url}/public-shell/offline.html`);
 await page.evaluate(async()=>{const {mountShareToDeal}=await import('/js/ui-share-to-deal.js');const host=document.createElement('div');document.body.replaceChildren(host);globalThis.shareCalls={begin:0,read:0};await mountShareToDeal(host,{getBoard:async()=>({actor:'joe',deals:[{id:'demo',name:'Demo deal'}]}),beginDealDocumentUpload:async()=>{shareCalls.begin++;throw Error('network interrupted');},readDealDocumentUpload:async()=>{shareCalls.read++;throw Error('network interrupted');},listDealDocuments:async()=>({documents:[]})});});
 await page.getByLabel('Choose files',{exact:true}).setInputFiles({name:'Demo cap.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-synthetic')});await page.getByRole('combobox',{name:'Deal'}).selectOption('demo');
 await page.getByRole('button',{name:'File documents',exact:true}).click();await page.getByRole('button',{name:'Check unresolved files',exact:true}).waitFor();
 await page.getByRole('button',{name:'Check unresolved files',exact:true}).click();await page.getByText('Wait one minute before checking the same receipt again.',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>shareCalls),{begin:1,read:0});
 await page.clock.fastForward(60001);assert.deepEqual(await page.evaluate(()=>shareCalls),{begin:1,read:0});
 await page.getByRole('button',{name:'Check unresolved files',exact:true}).click();await page.waitForFunction(()=>shareCalls.read===1);assert.deepEqual(await page.evaluate(()=>shareCalls),{begin:1,read:1});
});
