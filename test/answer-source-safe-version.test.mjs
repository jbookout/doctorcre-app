import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({entryPoints:['src/ui/answer-block-model.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const { parseAnswerBlocks } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
const fact_id = '11111111-1111-4111-8111-111111111111';
const blocks = source => [{type:'table.v1',id:'safe',columns:[{key:'amount',label:'Amount',type:'number'}],rows:[{amount:{value:24,source}}]}];
test('positive safe fact versions and record sources remain usable', () => {
  for (const version of [1, 2, Number.MAX_SAFE_INTEGER]) assert.equal(parseAnswerBlocks(blocks({fact_id,version})).kind,'valid');
  assert.equal(parseAnswerBlocks(blocks({record_id:fact_id})).kind,'valid');
  assert.equal(parseAnswerBlocks(undefined).kind,'text');
  assert.equal(parseAnswerBlocks([]).kind,'text');
});
test('zero, negative, fractional, unsafe and nonfinite fact versions refuse the answer', () => {
  for (const version of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,Number.MAX_VALUE,NaN,Infinity,-Infinity]) {
    assert.equal(parseAnswerBlocks(blocks({fact_id,version})).kind,'invalid',String(version));
  }
});
test('distinct unsafe JSON literals round together and both refuse the answer', () => {
  const first = JSON.parse(JSON.stringify(blocks({fact_id,version:1})).replace('"version":1','"version":9007199254740992'));
  const second = JSON.parse(JSON.stringify(blocks({fact_id,version:1})).replace('"version":1','"version":9007199254740993'));
  assert.equal(first[0].rows[0].amount.source.version,second[0].rows[0].amount.source.version);
  for (const input of [first,second]) assert.equal(parseAnswerBlocks(input).kind,'invalid');
});
