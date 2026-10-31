import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountDealItemSheet } from '../js/deal-item-sheet.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('Tell Dr. CRE keeps the draft and does not submit', async () => {
 const {window} = new JSDOM('<body></body>'); const {document} = window;
 window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
 let writes = 0; const sheet = mountDealItemSheet({document, read: async () => ({items:[{id:'demo',title:'Demo',status:'open',bullets:[{kind:'status',text:'Earlier history'}]}]}), send: async () => { writes++; }, refresh() {}});
 sheet.open('deal','demo'); await tick(); const input=document.querySelector('textarea'); input.value='Synthetic draft';
 assert.equal(document.querySelector('[type="submit"]').disabled,true);
 assert.match(document.querySelector('form').textContent,/Not submitted\. This control cannot send a request to Dr\. CRE\./);
 document.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})); await tick();
 assert.equal(input.value,'Synthetic draft'); assert.equal(writes,0); assert.match(document.body.textContent,/Earlier history/);
});
