import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { entryDetailsHtml } from '../js/entry-details.mjs';

test('notes preview one sentence and expand the escaped, complete original entry',()=>{
 const original='Synthetic note. Full original <script>unsafe()</script>\ncontinues here.';
 const doc=new JSDOM(entryDetailsHtml(original)).window.document;
 assert.equal(doc.querySelector('p').textContent,'Synthetic note.');
 assert.equal(doc.querySelector('summary').textContent,'Details');
 assert.equal(doc.querySelector('.entry-original').textContent,original);
 assert.equal(doc.querySelector('script'),null);
 assert.equal(new JSDOM(entryDetailsHtml('a'.repeat(220))).window.document.querySelector('p').textContent.length,180);
});
