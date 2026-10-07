import test from 'node:test';
import assert from 'node:assert/strict';
import * as harness from './browser-harness.mjs';

for (const width of [320, 390, 844]) test(`continuity oracle controls at ${width}px`, async t => {
  const browser = await harness.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width,height:960}, reducedMotion:'reduce'});
  await page.setContent(`<style>textarea{max-width:100%;box-sizing:border-box}dialog{max-width:80vw}p{overflow-wrap:anywhere}</style><button id="open">Open</button><textarea id="draft"></textarea><dialog id="outer"><p>${'Demo'.repeat(100)}</p><button id="nested">Nested</button><dialog id="inner"><button id="close">Close</button></dialog></dialog>`);
  await page.locator('#draft').fill('Demo unsaved '+ 'long draft '.repeat(80));
  await page.locator('#draft').focus();
  const refresh = () => page.evaluate(() => {
    const old=document.querySelector('#draft'), next=old.cloneNode(true); next.value=old.value;
    const start=old.selectionStart,end=old.selectionEnd; old.replaceWith(next); next.focus(); next.setSelectionRange(start,end);
  });
  await harness.retainDraftThroughRefresh(page, '#draft', refresh);
  await assert.rejects(harness.retainDraftThroughRefresh(page, '#draft', () => page.evaluate(() => {document.querySelector('#draft').value='';})), /draft/);
  await page.locator('#draft').fill('Demo again'); await page.locator('#draft').focus();
  await assert.rejects(harness.retainDraftThroughRefresh(page, '#draft', () => page.locator('#open').focus()), /focus/);
  await harness.assertFocusRoundTrip(page, '#open', () => page.evaluate(() => document.querySelector('#outer').showModal()), () => page.evaluate(() => document.querySelector('#outer').close()));
  await page.evaluate(() => document.querySelector('#outer').showModal());
  await harness.assertFocusRoundTrip(page, '#nested', () => page.evaluate(() => document.querySelector('#inner').showModal()), () => page.evaluate(() => document.querySelector('#inner').close()));
  await page.evaluate(() => document.querySelector('#outer').close());
  await assert.rejects(harness.assertFocusRoundTrip(page, '#open', async () => {}, () => page.locator('#draft').focus()), /focus/);
  await harness.assertFitsViewport(page, ['#draft']);
  await page.locator('#draft').evaluate(el => {el.style.width='1200px';el.style.maxWidth='none';});
  await assert.rejects(harness.assertFitsViewport(page, ['#draft']), /viewport/);
});
