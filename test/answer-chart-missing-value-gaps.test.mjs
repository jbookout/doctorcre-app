import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
const compiled = await build({entryPoints:['src/ui/answer-blocks.tsx'],bundle:true,write:false,format:'iife',globalName:'answers',platform:'browser',jsx:'automatic'});
const source = {record_id:'11111111-1111-4111-8111-111111111111'};
function blocks(values) {
  return [{type:'table.v1',id:'samples',columns:[{key:'year',label:'Year',type:'text'},{key:'value',label:'Value',type:'number'}],rows:values.map((value,index)=>({year:{value:String(2024+index)},value:{value, ...(value === null ? {} : {source})}}))}, {type:'chart.v1',id:'chart',table_id:'samples',kind:'line',x:'year',y:'value'}];
}
for (const [name, values, runs] of [
  ['interior',[10,null,30],[[0],[2]]],
  ['leading',[null,10,30],[[1,2]]],
  ['trailing',[10,30,null],[[0,1]]],
  ['repeated',[10,null,null,30,null,20],[[0],[3],[5]]],
  ['all null',[null,null,null],[]],
  ['contiguous',[-10,0,30],[[0,1,2]]],
  ['single point',[10],[[0]]],
  ['empty',[],[]],
]) test(`${name} preserves source positions and separates unknown intervals`, async()=>{
  const dom = new JSDOM('<div id="host"></div>',{runScripts:'dangerously',pretendToBeVisual:true});
  dom.window.TextEncoder = TextEncoder;
  dom.window.eval(compiled.outputFiles[0].text + ';window.answers = answers;');
  const host = dom.window.document.querySelector('#host');
  try {
    dom.window.answers.mountAnswerBlocks(host, blocks(values), name);
    const deadline = Date.now()+30000;
    while (!host.querySelector('.answer-chart')) {
      assert.ok(Date.now()<deadline,'answer chart commits within the test deadline');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    const lines = [...host.querySelectorAll('polyline')].map(p=>p.getAttribute('points').split(' ').map(pair=>Number(pair.split(',')[0])));
    assert.deepEqual(lines,runs.map(run=>run.map(index=>30+index*540/Math.max(1,values.length))));
    assert.equal(host.querySelectorAll('circle').length,values.filter(v=>v!==null).length);
    assert.equal(host.querySelectorAll('tbody tr').length,values.length);
    dom.window.answers.disposeAnswerBlocks(host);
    assert.equal(host.textContent,'');
  } finally {dom.window.close();}
});
