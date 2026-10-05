import { parse } from 'acorn';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ASSERTIONS = new Set(['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual']);
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const REVISION = /^[a-f0-9]{40}$/;

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}

const property = node => node?.computed ? node.property?.value : node?.property?.name;
const key = node => node?.computed ? node.key?.value : node?.key?.name ?? node?.key?.value;
const contractPath = value => typeof value === 'string' && /(?:^|\/)contracts\/[^/]+\.json$/.test(value);
const rootName = node => node?.type === 'Identifier' ? node.name
  : node?.type === 'MemberExpression' ? rootName(node.object) : undefined;

// Syntax inspection keeps example strings, comments and fixture versions out
// of the check. Contracts own pins; tests assert capabilities and compare the
// Worker/build against those contracts rather than maintaining another pin.
export function testContractFindings(source) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const objects = new Set();
  const functions = new Set();
  const constants = new Map();
  const contracts = new Set();
  for (const node of tree.body) {
    if (node.type === 'ImportDeclaration' && /^node:assert(?:\/strict)?$/.test(node.source.value)) {
      for (const specifier of node.specifiers) {
        if (specifier.type !== 'ImportSpecifier') objects.add(specifier.local.name);
        else if (ASSERTIONS.has(specifier.imported.name)) functions.add(specifier.local.name);
      }
    }
    if (node.type === 'ImportDeclaration' && contractPath(node.source.value)) {
      node.specifiers.forEach(specifier => contracts.add(specifier.local.name));
    }
    if (node.type === 'VariableDeclaration' && node.kind === 'const') {
      for (const { id, init } of node.declarations) if (id.type === 'Identifier') constants.set(id.name, init);
    }
  }
  walk(tree, node => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier') return;
    walk(node.init, child => {
      if (child.type === 'Literal' && contractPath(child.value)) contracts.add(node.id.name);
    });
  });
  // Also accepts source snippets in the guard's negative controls.
  objects.add('assert');
  const literal = node => node?.type === 'Literal' ? node.value
    : node?.type === 'Identifier' && constants.get(node.name)?.type === 'Literal' ? constants.get(node.name).value : undefined;
  const fieldPin = (name, node) => typeof literal(node) === 'string'
    && (name === 'version' && VERSION.test(literal(node)) || name === 'source_commit' && REVISION.test(literal(node)));
  const objectPin = (node, metadataOnly = false) => {
    let found = false;
    walk(node, child => {
      if (child.type !== 'Property') return;
      if (metadataOnly) {
        if (['carr_contract', 'route_contract'].includes(key(child)) && objectPin(child.value)) found = true;
      } else if (fieldPin(key(child), child.value)) found = true;
    });
    return found;
  };
  const findings = [];
  walk(tree, node => {
    if (node.type !== 'CallExpression') return;
    const { callee, arguments: args } = node;
    const assertion = callee.type === 'MemberExpression' && objects.has(callee.object.name) && ASSERTIONS.has(property(callee))
      || callee.type === 'Identifier' && functions.has(callee.name);
    if (!assertion || args.length < 2) return;
    const bound = args.slice(0, 2).some(arg => contracts.has(rootName(arg)));
    if (args.slice(0, 2).some(arg => objectPin(arg, !bound))
      || contracts.has(rootName(args[0])) && fieldPin(property(args[0]), args[1])
      || contracts.has(rootName(args[1])) && fieldPin(property(args[1]), args[0])) {
      findings.push({ line: node.loc.start.line, message: 'derive contract expectations from the contract; assert the required feature instead of a literal version or producer revision' });
    }
  });
  return findings;
}

export async function checkTestContracts(root) {
  const problems = [];
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.name.endsWith('.mjs')) {
        for (const finding of testContractFindings(await readFile(path, 'utf8'))) {
          problems.push(`${relative(root, path)}:${finding.line}: ${finding.message}`);
        }
      }
    }
  }
  await scan(join(root, 'test'));
  if (problems.length) throw new Error(problems.join('\n'));
}
