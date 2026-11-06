import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSync } from '@babel/core';
import { validateCarrFixture, validateCarrRecordings } from '../test/support/carr-fixture-contract.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const name = node => node?.name ?? node?.value;
const isResponse = keys => keys.has('ok') || keys.has('schema_version') || keys.has('jsonrpc')
  || keys.has('filings') || keys.has('sections') || keys.has('coverage')
  || (keys.has('state') && keys.has('items'));

function staticValue(node) {
  if (node.type === 'ObjectExpression') return Object.fromEntries(node.properties.map(prop => {
    if (prop.type !== 'ObjectProperty' || prop.computed) throw new Error('recordings must be static data');
    return [name(prop.key),staticValue(prop.value)];
  }));
  if (node.type === 'ArrayExpression') return node.elements.map(staticValue);
  if (['StringLiteral','NumericLiteral','BooleanLiteral'].includes(node.type)) return node.value;
  if (node.type === 'NullLiteral') return null;
  if (node.type === 'UnaryExpression' && node.operator === '-') return -staticValue(node.argument);
  throw new Error('recordings must be static data');
}

export function responseLiterals(path,source) {
  const literals = [];
  if (path.endsWith('.json')) {
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if (value.records && (value.producer || value.provenance)) { validateCarrRecordings(value); return; }
      if (!Array.isArray(value) && isResponse(new Set(Object.keys(value)))) literals.push({digest:digest(JSON.stringify(value)),line:1});
      for (const child of Object.values(value)) walk(child);
    };
    walk(JSON.parse(source));
    return literals;
  }
  const ast = parseSync(source,{configFile:false,babelrc:false,parserOpts:{sourceType:'unambiguous',plugins:['typescript','jsx']}});
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ObjectExpression') {
      const keys = new Set(node.properties.map(prop => name(prop.key)));
      if (keys.has('records') && (keys.has('producer') || keys.has('provenance'))) {
        let group;
        try { group = staticValue(node); } catch { /* Dynamic test builders are scanned below. */ }
        if (group) { validateCarrRecordings(group); return; }
      }
    }
    if (node.type === 'ObjectExpression' && isResponse(new Set(node.properties.map(prop => name(prop.key))))) {
      literals.push({digest:digest(source.slice(node.start,node.end)),line:node.loc.start.line});
    }
    for (const [key,value] of Object.entries(node)) {
      if (key === 'loc') continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(ast);
  return literals;
}

export async function fixtureFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(join(root,directory),{withFileTypes:true}).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      const path = join(directory,entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:[cm]?js|tsx?|json)$/.test(path)) files.push(path);
    }
  }
  for (const dir of ['test','tests','scripts']) await walk(dir);
  return files.sort();
}

export const literalInventoryDigest = literals => digest(JSON.stringify(literals.map(literal => literal.digest).sort()));

export async function checkCarrFixtures(root,legacy) {
  root = root instanceof URL ? fileURLToPath(root) : root;
  const errors = [];
  for (const path of await fixtureFiles(root)) {
    if (path === 'test/fixtures/carr-legacy-literals.json') continue;
    const source = await readFile(join(root,path),'utf8');
    if (path.startsWith('test/fixtures/carr/')) {
      try { validateCarrFixture(JSON.parse(source)); }
      catch (error) { errors.push(`${path}: ${error.message}`); }
      continue;
    }
    let literals;
    try { literals = responseLiterals(path,source); }
    catch (error) { errors.push(`${path}: ${error.message}`); continue; }
    if (literals.length && literalInventoryDigest(literals) !== legacy[path]) {
      errors.push(`${path}:${literals[0].line}: unchecked CARR response literal; use checkedCarrFixture and a producer replay record`);
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = new URL('../',import.meta.url);
  const legacy = JSON.parse(await readFile(new URL('test/fixtures/carr-legacy-literals.json',root),'utf8'));
  const errors = await checkCarrFixtures(root,legacy);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('CARR fixture replay and unchecked-response inventory passed');
}
