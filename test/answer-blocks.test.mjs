import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const compiled = await build({entryPoints:['src/ui/answer-block-model.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {parseAnswerBlocks, tableRows} = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
const source = {record_id:'11111111-1111-4111-8111-111111111111'};
const table = {type:'table.v1',id:'comps',columns:[{key:'name',label:'Deal',type:'text'},{key:'rent',label:'Proposed rent ($/SF/year)',type:'number'}],rows:[{name:{value:'B'},rent:{value:0,source}},{name:{value:'A'},rent:{value:-2,source}},{name:{value:'C'},rent:{value:null}}]};
const chart = {type:'chart.v1',id:'rents',table_id:'comps',kind:'bar',x:'name',y:'rent'};
test('renders_sourced_comps_turn_as_sortable_table_not_only_prose',()=>{
  assert.equal(parseAnswerBlocks([table]).kind,'valid');
  assert.deepEqual(tableRows(table,{key:'rent',direction:'asc'},'').map(r=>r.name.value),['A','B','C']);
  assert.deepEqual(tableRows(table,{key:'rent',direction:'desc'},'').map(r=>r.name.value),['B','A','C']);
  assert.equal(tableRows(table,null,'a').length,1);
});
test('strict contract refuses malformed, coerced, forged, duplicate and dangling blocks',()=>{
  for(const blocks of [[{...table,type:'html'}],[table,table],[chart],Array(9).fill(table),[{...table,rows:Array(201).fill(table.rows[0])}],[{...table,columns:[...table.columns,table.columns[0]]}],[{...table,rows:[{name:{value:'x'},rent:{value:'2'}}]}],[{...table,rows:[{name:{value:'x'},rent:{value:2,source:{record_id:'https://evil'}}}]}],[{...table,extra:1}],[{...chart,table_id:'rents'},table]]) assert.equal(parseAnswerBlocks(blocks).kind,'invalid');
  assert.equal(parseAnswerBlocks(undefined).kind,'text');
  assert.equal(parseAnswerBlocks([]).kind,'text');
  assert.equal(parseAnswerBlocks([table,chart]).kind,'valid');
});
test('bounded maximum payload and invalid dates',()=>{
 const max = {...table,columns:Array.from({length:20},(_,i)=>({key:`c${i}`,label:`C${i}`,type:'text'})),rows:Array.from({length:200},()=>Object.fromEntries(Array.from({length:20},(_,i)=>[`c${i}`,{value:null}])))};
 assert.equal(parseAnswerBlocks([max]).kind,'valid');
 assert.equal(parseAnswerBlocks([{...max,columns:[...max.columns,{key:'overflow',label:'Overflow',type:'text'}]}]).kind,'invalid');
 assert.equal(parseAnswerBlocks([{...table,columns:[{key:'date',label:'Date',type:'date'}],rows:[{date:{value:'2026-02-30'}}]}]).kind,'invalid');
 assert.equal(parseAnswerBlocks([{...table,rows:[{name:{value:'x'.repeat(2001)},rent:{value:0,source}}]}]).kind,'invalid');
});
test('eight blocks, boolean/date cells, versioned facts and payload byte ceiling',async()=>{
 assert.equal(parseAnswerBlocks(Array.from({length:8},(_,i)=>({...table,id:`table${i}`}))).kind,'valid');
 const typed={type:'table.v1',id:'typed',columns:[{key:'day',label:'Day',type:'date'},{key:'flag',label:'Flag',type:'boolean'},{key:'rate',label:'Rate',type:'number'}],rows:[{day:{value:'2026-11-03'},flag:{value:false},rate:{value:0,source:{fact_id:source.record_id,version:2}}}]};
 assert.equal(parseAnswerBlocks([typed]).kind,'valid');
 assert.equal(parseAnswerBlocks([{...table,rows:[{name:{value:'😀'.repeat(2000)},rent:{value:0,source}}]}]).kind,'valid');
 assert.equal(parseAnswerBlocks([{...typed,rows:[{...typed.rows[0],rate:{value:0,source:{fact_id:source.record_id,version:0}}}]}]).kind,'invalid');
 const large={...table,rows:Array.from({length:200},()=>({name:{value:'a'.repeat(2000)},rent:{value:1,source}}))};
 assert.equal(parseAnswerBlocks([large]).kind,'invalid');
 const schema=JSON.parse(await readFile('contracts/carr-interface.v1/answer_blocks.json','utf8'));
 assert.equal(schema.maxItems,8);
});
