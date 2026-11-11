import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function assertChartGaps(page) {
  const results = [];
  const mount = async (values, kind = 'line', absent = false) => {
    await page.evaluate(async ({values, kind, absent}) => {
      const api = await import('/js/ui-answers.generated.js');
      const host = document.querySelector('#proof');
      const source = {record_id:'11111111-1111-4111-8111-111111111111'};
      const table = {type:'table.v1',id:'samples',columns:[{key:'year',label:'Year',type:'text'},{key:'value',label:'Value',type:'number'}],rows:values.map((value,index)=>({year:{value:String(2024+index)},...(absent && value === null ? {} : {value:{value,...(value === null ? {} : {source})}})}))};
      api.mountAnswerBlocks(host,[table,{type:'chart.v1',id:'chart',table_id:'samples',kind,x:'year',y:'value'}],'proof');
    }, {values, kind, absent});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  for (const [name,values,runs] of [
    ['interior',[10,null,30],[[0],[2]]], ['leading',[null,10,30],[[1,2]]],
    ['trailing',[10,30,null],[[0,1]]], ['repeated',[10,null,null,30,null,20],[[0],[3],[5]]],
    ['all-null',[null,null,null],[]], ['contiguous',[-10,0,30],[[0,1,2]]],
    ['single',[10],[[0]]], ['empty',[],[]],
  ]) {
    await mount(values);
    await page.locator('#proof .answer-chart').waitFor();
    const observed = await page.locator('#proof').evaluate(host => ({
      lines:[...host.querySelectorAll('polyline')].map(p=>p.getAttribute('points')),
      points:[...host.querySelectorAll('circle')].map(p=>[Number(p.getAttribute('cx')),Number(p.getAttribute('cy')),p.getAttribute('aria-label')]),
      rows:host.querySelectorAll('tbody tr').length,
      sources:host.querySelectorAll('.answer-source').length,
      values:[...host.querySelectorAll('tbody tr')].map(row=>row.cells[1].childNodes[0]?.textContent),
      label:host.querySelector('svg')?.getAttribute('aria-label'),
    }));
    const known = values.flatMap((value,index)=>value === null ? [] : [{value,index}]);
    const scale = Math.max(1,...known.map(p=>Math.abs(p.value)));
    const min = Math.min(0,...known.map(p=>p.value/scale)), max = Math.max(0,...known.map(p=>p.value/scale));
    const x = index=>30+index*540/Math.max(1,values.length);
    const y = value=>180-(value/scale-min)/(max-min || 1)*160;
    assert.deepEqual(observed.lines,runs.map(run=>run.map(index=>`${x(index)},${y(values[index])}`).join(' ')),name);
    assert.deepEqual(observed.points,known.map(p=>[x(p.index),y(p.value),`${2024+p.index}: ${p.value}`]),name);
    assert.equal(observed.rows,values.length,name);
    assert.equal(observed.sources,known.length,name);
    assert.deepEqual(observed.values,values.map(value=>value === null ? '—' : String(value)),name);
    assert.equal(observed.label,'Value by Year');
    for (const [index,sample] of known.entries()) {
      const point = page.locator('#proof circle').nth(index);
      const status = page.locator('#proof .answer-chart [role="status"]');
      const text = `${2024+sample.index}: ${sample.value}`;
      await point.focus();
      await status.filter({hasText:text}).waitFor();
      await page.locator('#proof input').focus();
      await status.filter({hasText:'Focus or hover'}).waitFor();
      await point.hover();
      await status.filter({hasText:text}).waitFor();
      await page.mouse.move(0,0);
      await status.filter({hasText:'Focus or hover'}).waitFor();
    }
    results.push({name,passed:true});
  }
  await mount([10,null,-30],'bar');
  assert.equal(await page.locator('#proof rect').count(),2);
  assert.equal(await page.locator('#proof polyline').count(),0);
  assert.deepEqual(await page.locator('#proof rect').evaluateAll(nodes=>nodes.map(n=>Number(n.getAttribute('x')))),[30,390]);
  results.push({name:'null-bars-omitted',passed:true});
  await mount([10,null,30],'line',true);
  assert.equal(await page.locator('#proof').textContent(),'Interactive answer unavailable');
  results.push({name:'absent-cell-contract-refusal',passed:true});
  for (const active of [false,true]) {
    await mount([10,null,30]);
    if (active) await page.locator('#proof circle').first().focus();
    await mount([null,-5,10]);
    assert.equal(await page.locator('#proof polyline').count(),1);
    assert.equal(await page.locator('#proof .answer-chart [role="status"]').textContent(),'Focus or hover a value to inspect it.');
    if (active) await page.locator('#proof circle').first().focus();
    await page.evaluate(async()=>{const api=await import('/js/ui-answers.generated.js'); const host=document.querySelector('#proof');api.disposeAnswerBlocks(host);api.disposeAnswerBlocks(host);});
    assert.equal(await page.locator('#proof').textContent(),'');
  }
  results.push({name:'changed-answer-and-disposal',passed:true});
  return results;
}

export async function prove({origin, timeoutMs}) {
  const base = new URL(origin);
  if (base.origin !== origin || !['http:','https:'].includes(base.protocol)) throw new Error('origin must be an HTTP origin');
  const controller = new AbortController();
  let browser;
  let release;
  let releaseBytes;
  const assets = new Map();
  let requests = 0;
  const deadline = Date.now() + timeoutMs;
  const unavailable = message => Object.assign(new Error(message),{exitCode:78});
  const fetchBytes = async path => {
    if (++requests > 20) throw unavailable('asset request cap exceeded');
    const response = await proofFetch(new URL(path,origin),{signal:controller.signal,redirect:'error'}).catch(()=>{throw unavailable('asset unavailable');});
    if (!response.ok) throw unavailable('asset unavailable');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 2_000_000) throw unavailable('asset too large');
    return bytes;
  };
  let timer;
  try {
    return await Promise.race([ (async()=>{
      release = await readAppRelease(origin, async url => ({ type: 'application/json', body: releaseBytes = await fetchBytes(url.pathname) }));
      const pending = ['/js/ui-answers.generated.js'];
      while (pending.length) {
        const path = pending.shift();
        if (assets.has(path)) continue;
        const bytes = await fetchBytes(path);
        assets.set(path,bytes);
        for (const match of bytes.toString().matchAll(/(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g)) {
          const url = new URL(match[1],new URL(path,origin));
          if (url.origin !== origin || !/^\/js\/ui-shared-[A-Z0-9]+\.generated\.js$/.test(url.pathname) || url.search || url.hash) throw unavailable('module outside allowlist');
          if (!assets.has(url.pathname)) pending.push(url.pathname);
        }
      }
      browser = await launchProofBrowser(chromium, {headless:true,args: [...CHROMIUM_SAFETY_ARGS],timeout:Math.max(1,deadline-Date.now())}, { signal: controller.signal });
      if (controller.signal.aborted) {await browser.close();throw unavailable('total deadline exceeded');}
      const page = await browser.newPage({serviceWorkers:'block'});
      page.setDefaultTimeout(Math.max(1,deadline-Date.now()));
      await page.route('**/*',route=>{
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/__answer_gap_proof__') return route.fulfill({contentType:'text/html',body:'<div id="proof"></div>'});
        const bytes = assets.get(url.pathname);
        return bytes && route.request().method() === 'GET' ? route.fulfill({contentType:'text/javascript',body:bytes}) : route.abort();
      });
      await page.goto(origin+'/__answer_gap_proof__');
      const assertions = await assertChartGaps(page);
      return {release,assets:[{path:'/app-release',sha256:createHash('sha256').update(releaseBytes).digest('hex')},...Array.from(assets,([path,bytes])=>({path,sha256:createHash('sha256').update(bytes).digest('hex')}))],requests,assertions};
    })(), new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort(unavailable('total deadline exceeded'));reject(controller.signal.reason);},timeoutMs);}) ]);
  } catch (error) {
    error.proof = {release,assets:[...(releaseBytes ? [{path:'/app-release',sha256:createHash('sha256').update(releaseBytes).digest('hex')}] : []),...Array.from(assets,([path,bytes])=>({path,sha256:createHash('sha256').update(bytes).digest('hex')}))],requests,assertions:[{name:error.message,passed:false}]};
    throw error;
  } finally {clearTimeout(timer);controller.abort();await browser?.close();}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--timeout-ms' || !/^\d+$/.test(args[3]) || Number(args[3]) < 1 || Number(args[3]) > 30000) throw new Error('use --origin <origin> --timeout-ms <1..30000>');
    console.log(JSON.stringify(await prove({origin:args[1],timeoutMs:Number(args[3])})));
  } catch (error) {console.log(JSON.stringify({error:error.message,...error.proof}));process.exitCode=error.exitCode ?? 1;}
}
