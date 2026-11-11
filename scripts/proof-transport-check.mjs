// Threat model: accidental bypass by our own builders, not a determined adversary.
// Static checks catch obvious forms; proof fixtures enforce the reader marker at runtime.
import { parseSync, traverse } from '@babel/core';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const networkModules = /^(?:node:)?(?:https?|http2|net|tls|dgram|dns|undici)(?:\/|$)|^(?:axios|got|node-fetch|ws)$/;
const controlledImports = new Map([
  ['child_process', ['execFileSync', 'execFile']], ['playwright', ['chromium']],
  ['playwright-core', ['chromium']], ['@playwright/test', ['chromium']],
]);

function parseProofSource(source, filename) {
  if (filename.endsWith('.ts')) {
    try { source = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: filename }); }
    catch (error) { throw new Error(`Node TypeScript stripping refused: ${error.message}`, { cause: error }); }
  }
  return parseSync(source, { sourceType: 'module', configFile: false, babelrc: false });
}

export function checkProofSource(source, filename = 'proof.mjs') {
  const errors = [];
  const fail = (node, reason) => errors.push(`${filename}:${node.loc?.start.line || 1}: ${reason}`);
  let ast;
  try { ast = parseProofSource(source, filename); }
  catch (error) { return [`${filename}: ${error.message}`]; }
  const subprocessNames = new Set();
  for (const node of ast.program.body) if (node.type === 'ImportDeclaration' && node.source.value.replace(/^node:/, '') === 'child_process') for (const specifier of node.specifiers) subprocessNames.add(specifier.local.name);
  function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportDeclaration') {
      const module = node.source.value.replace(/^node:/, '');
      if (networkModules.test(module)) fail(node, `network module must use shared reader ${module}`);
      const allowed = controlledImports.get(module);
      if (allowed) for (const specifier of node.specifiers) {
        const name = specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported?.name;
        if (!allowed.includes(name)) fail(node, `undeclared network capability ${module} ${name || '*'}`);
      }
    }
    if (node.type === 'CallExpression') {
      if (node.callee.type === 'Identifier' && subprocessNames.has(node.callee.name)) {
        const [command, args] = node.arguments;
        if (command?.value !== 'git' || args?.type !== 'ArrayExpression' || !['rev-parse', 'merge-base', 'log'].includes(args.elements[0]?.value)) fail(node, 'only declared read-only git subprocesses are allowed');
      }
    }
    if (node.type === 'Identifier' && ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'require', 'eval', 'Function'].includes(node.name) && !(node.name === 'fetch' && parent?.type === 'MemberExpression' && parent.property === node)) fail(node, `HTTP and code loading must use declared proof interfaces (${node.name})`);
    if (node.type === 'MemberExpression' && node.property?.name === 'fetch') {
      const options = parent?.arguments?.[0];
      if (node.object?.name !== 'route' || parent?.type !== 'CallExpression' || parent.callee !== node || options?.type !== 'ObjectExpression' || options.properties.some(property => !['maxRedirects', 'timeout'].includes(property.key?.name))) fail(node, 'only the declared asset route may fetch through the browser');
    }
    if (node.type === 'StringLiteral' && /\/app-release(?:[?#]|$)/.test(node.value) && parent?.type === 'CallExpression' && parent.callee?.property?.name === 'goto') fail(node, 'release HTTP belongs to the shared reader');
    if (node.type === 'MemberExpression' && node.property?.name === 'request' && node.object?.name !== 'verb' && !(parent?.type === 'CallExpression' && parent.callee === node)) fail(node, 'browser HTTP clients must use the shared reader');
    if (node.type === 'MemberExpression' && ['globalThis', 'global', 'self', 'window', 'process'].includes(node.object?.name)) {
      if (node.computed || ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'getBuiltinModule', 'mainModule'].includes(node.property?.name)) fail(node, 'network capability must use declared proof interfaces');
    }
    if (node.type === 'Identifier' && ['globalThis', 'global', 'self', 'process'].includes(node.name) && !(parent?.type === 'MemberExpression' && parent.object === node)) fail(node, 'cannot alias global network capabilities');
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => visit(child, node));
      else if (value && typeof value === 'object') visit(value, node);
    }
  }
  const browserFunctions = new Set();
  traverse(ast, { CallExpression(path) {
    const callee = path.node.callee;
    if (callee.type !== 'MemberExpression' || callee.property.name !== 'evaluate') return;
    const argument = path.get('arguments.0');
    if (argument?.isFunction()) browserFunctions.add(argument.node);
    else if (argument?.isIdentifier()) {
      const binding = argument.scope.getBinding(argument.node.name);
      if (binding?.path.isFunctionDeclaration()) browserFunctions.add(binding.path.node);
      else if (binding?.path.isVariableDeclarator()) browserFunctions.add(binding.path.node.init);
    }
  } });
  traverse(ast, { ImportExpression(path) {
    const source = path.node.source;
    if (source.type === 'StringLiteral' && !networkModules.test(source.value) && !controlledImports.has(source.value.replace(/^node:/, ''))) return;
    if (source.type === 'StringLiteral' && source.value === 'playwright') {
      const declaration = path.parentPath.isAwaitExpression() ? path.parentPath.parent : path.parent;
      if (declaration.type !== 'VariableDeclarator' || declaration.id.type !== 'ObjectPattern' || declaration.id.properties.some(property => property.key?.name !== 'chromium')) fail(path.node, 'only the declared Chromium driver may be loaded');
      return;
    }
    const browserFunction = path.findParent(parent => parent.isFunction() && browserFunctions.has(parent.node));
    if (browserFunction) return;
    if (filename === 'prove-waiting-editor-canonical-reopen.mjs' && source.type === 'TemplateLiteral' && source.quasis[0].value.raw === 'data:text/javascript;base64,' && source.expressions[0]?.type === 'CallExpression' && source.expressions[0].callee?.property?.name === 'toString') return;
    fail(path.node, 'module loading outside the declared browser evaluation');
  }, ReferencedIdentifier(path) {
    if (subprocessNames.has(path.node.name) && !(path.parent.type === 'CallExpression' && path.parent.callee === path.node)) fail(path.node, 'cannot alias a subprocess capability');
  } });
  visit(ast);
  return [...new Set(errors)];
}

export async function proofRunners(root = new URL('../', import.meta.url)) {
  return (await readdir(new URL('scripts/', root))).filter(name => /^prove-.*\.(?:mjs|ts)$/.test(name));
}

export async function checkProofTransports(root = new URL('../', import.meta.url)) {
  const scripts = new URL('scripts/', root);
  const errors = [];
  // These app clients are exercised with data: seeds and injected fixture transports.
  const appFixtureClients = new Set(['../js/fixture-client.js', '../js/live-client.js'].map(path => new URL(path, scripts).href));
  const visited = new Map();
  async function inspect(url, depth) {
    if (url.href === new URL('./proof-browser.mjs', import.meta.url).href || appFixtureClients.has(url.href) || url.href === new URL('app-release-reader.mjs', scripts).href || (visited.get(url.href) ?? -1) >= depth) return;
    visited.set(url.href, depth);
    const source = await readFile(url, 'utf8');
    const filename = url.href.slice(root.href.length);
    if (url.pathname.endsWith('.json')) {
      try { JSON.parse(source); }
      catch { errors.push(`${filename}: invalid JSON import`); }
      return;
    }
    errors.push(...checkProofSource(source, filename.replace(/^scripts\//, '')));
    if (depth === 0) return;
    let ast;
    try { ast = parseProofSource(source, filename); }
    catch { return; }
    for (const node of ast.program.body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) continue;
      if (node.source?.value.startsWith('.')) await inspect(new URL(node.source.value, url), depth - 1);
    }
  }
  for (const file of await proofRunners(root)) {
    if (file === 'prove-loop-lint-coverage.mjs') {
      const source = await readFile(new URL(file, scripts));
      if (createHash('sha256').update(source).digest('hex') !== '95cbfc129bd562eb2c4fb68c26bca75bbaf3f05c94844a9c2b37fadba1ac338a') errors.push(`${file}: historical lint test changed; re-review its capabilities`);
      continue;
    }
    await inspect(new URL(file, scripts), 2);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = await checkProofTransports(process.argv[2] ? pathToFileURL(process.argv[2] + '/') : undefined);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Proof HTTP transport allowlist passed');
}
