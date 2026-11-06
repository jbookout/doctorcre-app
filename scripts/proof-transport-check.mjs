import { parseSync, traverse } from '@babel/core';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const imports = new Map(Object.entries({
  'node:assert/strict': ['default'], 'node:crypto': ['createHash'],
  'node:url': ['pathToFileURL', 'fileURLToPath'], 'node:util': ['parseArgs'],
  'node:fs': ['readFileSync'], 'node:fs/promises': ['readFile'],
  'node:path': ['resolve', 'dirname', 'join'],
  'node:child_process': ['execFileSync'],
  'playwright': ['chromium'], 'es-module-lexer': ['init', 'parse'],
  'esbuild': ['context'], 'ajv': ['default'],
  './chromium-safety-args.mjs': ['CHROMIUM_SAFETY_ARGS'],
  './app-release-reader.mjs': ['readAppRelease', 'proofFetch', 'launchProofBrowser'],
  '../js/fixture-client.js': ['createFixtureClient'], '../js/live-client.js': ['createLiveClient'],
}));

// Browser module imports are evaluated in the isolated page, never by Node.
const browserModuleArguments = new Set(['moduleURL', 'assetUrl', 'moduleUrl', 'url', 'asset', 'entry']);
const globals = new Map(Object.entries({
  process: ['argv', 'exitCode', 'stdout', 'stderr'],
  globalThis: [], global: [], self: [],
  window: ['dispatchEvent', 'addEventListener', 'removeEventListener', 'proofCalls', 'proofPanel', 'calendarProof', 'sessionStorage', 'agendaProof', 'taxonomyProof', 'proofRequests', 'retirementProof'],
}));

export function checkProofSource(source, filename = 'proof.mjs') {
  const errors = [];
  const fail = (node, reason) => errors.push(`${filename}:${node.loc?.start.line || 1}: ${reason}`);
  let ast;
  try { ast = parseSync(source, { sourceType: 'module', configFile: false, babelrc: false }); }
  catch (error) { return [`${filename}: ${error.message}`]; }
  const subprocessNames = new Set();
  for (const node of ast.program.body) if (node.type === 'ImportDeclaration' && node.source.value === 'node:child_process') for (const specifier of node.specifiers) subprocessNames.add(specifier.local.name);
  function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportDeclaration') {
      const allowed = imports.get(node.source.value);
      for (const specifier of node.specifiers) {
        const name = specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported?.name;
        if (!allowed?.includes(name)) fail(node, `undeclared proof import ${node.source.value} ${name || '*'}`);
      }
      if (!allowed || !node.specifiers.length) fail(node, `undeclared proof import ${node.source.value}`);
    }
    if (node.type === 'ImportExpression') {
      const arg = node.source;
      if (!(arg?.type === 'StringLiteral' && (arg.value === 'playwright' || /^\/js\/[\w.-]+\.(?:m?js)$/.test(arg.value))) && !(arg?.type === 'Identifier' && browserModuleArguments.has(arg.name)) && !(arg?.type === 'TemplateLiteral' && arg.quasis[0].value.raw === 'data:text/javascript;base64,')) fail(node, 'undeclared dynamic proof import');
    }
    if (node.type === 'CallExpression') {
      if (node.callee.type === 'Import') {
        const arg = node.arguments[0];
        const allowed = arg?.type === 'StringLiteral'
          ? arg.value === 'playwright' || /^\/js\/[\w.-]+\.(?:m?js)$/.test(arg.value)
          : arg?.type === 'Identifier' && browserModuleArguments.has(arg.name);
        if (!allowed) fail(node, 'undeclared dynamic proof import');
      }
      if (node.callee.type === 'Identifier' && subprocessNames.has(node.callee.name)) {
        const [command, args] = node.arguments;
        if (command?.value !== 'git' || args?.type !== 'ArrayExpression' || !['rev-parse', 'merge-base', 'log'].includes(args.elements[0]?.value)) fail(node, 'only declared read-only git subprocesses are allowed');
      }
    }
    if (node.type === 'Identifier' && ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'require', 'eval', 'Function'].includes(node.name) && !(node.name === 'fetch' && parent?.type === 'MemberExpression' && parent.property === node)) fail(node, `HTTP and code loading must use declared proof interfaces (${node.name})`);
    if (node.type === 'MemberExpression' && node.property?.name === 'request' && node.object?.name !== 'verb' && !(parent?.type === 'CallExpression' && parent.callee === node)) fail(node, 'browser HTTP clients must use the shared reader');
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && globals.has(node.object.name)) {
      if (node.computed || !globals.get(node.object.name).includes(node.property.name)) fail(node, `undeclared ${node.object.name} capability`);
    }
    if (node.type === 'Identifier' && globals.has(node.name) && !(parent?.type === 'MemberExpression' && parent.object === node) && !(node.name === 'window' && parent?.type === 'ObjectProperty' && parent.shorthand)) fail(node, `cannot alias ${node.name} capabilities`);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => visit(child, node));
      else if (value && typeof value === 'object') visit(value, node);
    }
  }
  const allowedGlobals = new Set('AbortController AbortSignal Array Boolean Buffer Date Error Event Infinity Intl JSON Map Math NaN Number Object PopStateEvent Promise Response Set String URL clearTimeout console crypto dispatchEvent document encodeURIComponent history performance process requestAnimationFrame sessionStorage setTimeout structuredClone undefined window'.split(' '));
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
    if (!path.scope.hasBinding(path.node.name, true) && !allowedGlobals.has(path.node.name)) fail(path.node, `undeclared global capability ${path.node.name}`);
    if (subprocessNames.has(path.node.name) && !(path.parent.type === 'CallExpression' && path.parent.callee === path.node)) fail(path.node, 'cannot alias a subprocess capability');
  } });
  visit(ast);
  return [...new Set(errors)];
}

export async function checkProofTransports(root = new URL('../', import.meta.url)) {
  const scripts = new URL('scripts/', root);
  const errors = [];
  for (const file of (await readdir(scripts)).filter(name => /^prove-.*\.mjs$/.test(name))) {
    if (file === 'prove-loop-lint-coverage.mjs') {
      const source = await readFile(new URL(file, scripts));
      if (createHash('sha256').update(source).digest('hex') !== '195b8e915d2e15ebbd21c434a7906c6260d7f48d599a8de9e052c58017836cf2') errors.push(`${file}: historical lint test changed; re-review its capabilities`);
      continue;
    }
    errors.push(...checkProofSource(await readFile(new URL(file, scripts), 'utf8'), file));
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = await checkProofTransports(process.argv[2] ? pathToFileURL(process.argv[2] + '/') : undefined);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Proof HTTP transport allowlist passed');
}
