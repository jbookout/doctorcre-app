import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseSync } from '@babel/core';
import { transformSync } from 'esbuild';

const ROOT = new URL('../fixtures/', import.meta.url);
const pins = JSON.parse(readFileSync(new URL('carr-producers/pins.json', ROOT),'utf8'));
const digest = source => createHash('sha256').update(source).digest('hex');

function replay(record) {
  const pin = pins[record.producer];
  assert.ok(pin, `unknown producer ${record.producer}`);
  const source = readFileSync(new URL(`carr-producers/${pin.file}`,ROOT),'utf8');
  assert.equal(record.source_sha256, pin.sha256, 'fixture source pin differs from registered producer');
  assert.equal(digest(source), pin.sha256, 'producer source pin mismatch');
  const ast = parseSync(source, {configFile:false,babelrc:false,parserOpts:{sourceType:'module',plugins:['typescript']}});
  const declarations = ast.program.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node).filter(Boolean);
  const selected = declarations.filter(node => pin.declarations.includes(node.id?.name)
    || (node.type === 'VariableDeclaration' && node.declarations.some(decl => pin.declarations.includes(decl.id.name))))
    .map(node => source.slice(node.start,node.end)).join('\n');
  const js = transformSync(selected, {loader:'ts',target:'es2022'}).code;
  const produce = new Function(`${js}\nreturn ${pin.entry};`)();
  if (record.producer === 'calendar-section') {
    assert.ok(typeof record.input.now === 'string' && Number.isFinite(Date.parse(record.input.now)), 'calendar replay needs a deterministic clock');
    return produce(record.input.snapshot,new Date(record.input.now));
  }
  return produce(record.input.snapshot,record.input.query ?? {});
}

export function validateCarrFixture(record) {
  const actual = JSON.parse(JSON.stringify(replay(record)));
  assert.deepEqual(record.response,actual,`producer response mismatch for ${record.producer}`);
  return structuredClone(record.response);
}

export function checkedCarrFixture(name) {
  assert.match(name,/^[a-z0-9][a-z0-9-]*$/, 'fixture name must be a local slug');
  return validateCarrFixture(JSON.parse(readFileSync(new URL(`carr/${name}.json`,ROOT),'utf8')));
}
