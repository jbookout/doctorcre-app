import { parseSync, traverse } from '@babel/core';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const network = /^(?:node:)?(?:https?|http2|net|tls)$/;
const constructors = new Set(['createServer', 'createSecureServer', 'Server', 'Http2Server', 'Http2SecureServer']);
const transport = 'scripts/fixture-http.mjs';
const text = node => node?.type === 'StringLiteral' ? node.value : undefined;
const property = node => node.computed ? text(node.property) : node.property?.name;

export function checkFixtureSource(source, filename = 'fixture.mjs', { strictLoaders = true } = {}) {
  const errors = [], imports = [];
  const fail = (node, reason) => errors.push(`${filename}:${node.loc?.start.line || 1}: ${reason}`);
  let ast;
  try {
    ast = parseSync(source, { sourceType: 'unambiguous', configFile: false, babelrc: false,
      parserOpts: { plugins: /\.[cm]?tsx?$/.test(filename) ? [['typescript', { dts: /\.d\.[cm]?ts$/.test(filename) }], ...(/\.tsx$/.test(filename) ? ['jsx'] : [])] : ['jsx'] } });
  } catch (error) { return { errors: [`${filename}:1: ${error.message}`], imports }; }
  const isTransport = filename === transport;
  const loaders = new Set(['require']);
  traverse(ast, { VariableDeclarator(path) {
    const init = path.get('init');
    if (!init.isCallExpression()) return;
    const callee = init.get('callee');
    if (!callee.isIdentifier()) return;
    const binding = path.scope.getBinding(callee.node.name);
    if (binding?.path.isImportSpecifier() && binding.path.node.imported.name === 'createRequire' && path.node.id.type === 'Identifier') loaders.add(path.node.id.name);
  } });
  const moduleCheck = (node, name, names) => {
    if (typeof name !== 'string') { if (strictLoaders) fail(node, 'Dynamic module capability cannot be verified'); return; }
    if (name.startsWith('.')) imports.push(name);
    if (/^(?:express|serve-static|send|sirv|http-server|fastify|koa|connect)$/.test(name)) fail(node, 'Static server packages bypass fixture transport');
    if (isTransport && /^(?:node:)?fs(?:\/|$)/.test(name)) fail(node, 'Fixture transport cannot import filesystem APIs');
    if (!network.test(name) || isTransport) return;
    if (names.some(n => constructors.has(n) || n === '*')) fail(node, 'Server construction belongs to scripts/fixture-http.mjs');
  };
  function namespaceReferences(binding) {
    for (const reference of binding?.referencePaths || []) {
      const parent = reference.parentPath;
      if (parent.isMemberExpression() && parent.node.object === reference.node
        && property(parent.node) && !constructors.has(property(parent.node))) continue;
      if (parent.isVariableDeclarator() && parent.node.id.type === 'ObjectPattern'
        && parent.node.id.properties.every(p => p.type === 'ObjectProperty'
          && (p.computed ? text(p.key) : p.key.name || p.key.value)
          && !constructors.has(p.computed ? text(p.key) : p.key.name || p.key.value))) continue;
      fail(reference.node, 'Cannot alias or acquire a raw server capability');
    }
  }
  function loaderCapabilities(path) {
    const parent = path.parentPath.isAwaitExpression() ? path.parentPath.parentPath : path.parentPath;
    if (parent.isMemberExpression()) return [property(parent.node) || '*'];
    if (parent.isVariableDeclarator()) {
      const id = parent.node.id;
      if (id.type === 'ObjectPattern') return id.properties.map(p => p.type === 'ObjectProperty' ? p.computed ? text(p.key) || '*' : p.key.name || p.key.value : '*');
      if (id.type === 'Identifier') { namespaceReferences(parent.scope.getBinding(id.name)); return []; }
    }
    return ['*'];
  }
  traverse(ast, {
    ImportDeclaration(path) {
      const node = path.node;
      if (node.importKind === 'type') return;
      const name = node.source.value;
      // Namespace and default HTTP imports may expose read-only clients. Their references are checked below.
      moduleCheck(node, name, node.specifiers.filter(s => s.type === 'ImportSpecifier' && s.importKind !== 'type').map(s => s.imported.name || s.imported.value));
      if (!network.test(name) || isTransport) return;
      for (const spec of path.get('specifiers')) {
        if (spec.node.type === 'ImportSpecifier') continue;
        namespaceReferences(path.scope.getBinding(spec.node.local.name));
      }
    },
    ExportNamedDeclaration(path) {
      if (path.node.exportKind === 'type') return;
      if (path.node.source) moduleCheck(path.node, path.node.source.value, path.node.specifiers.map(s => s.local?.name || '*'));
      if (isTransport) {
        const names = path.node.declaration?.declarations?.map(d => d.id.name) || [path.node.declaration?.id?.name];
        names.push(...path.node.specifiers.map(s => s.exported?.name));
        if (names.filter(Boolean).some(n => !['startFixture', 'fixtureKey'].includes(n))) fail(path.node, 'Only descriptor transport exports are allowed');
      }
    },
    ExportDefaultDeclaration(path) { if (isTransport) fail(path.node, 'Default transport exports are forbidden'); },
    ExportAllDeclaration(path) { if (isTransport) fail(path.node, 'Transport re-exports are forbidden'); moduleCheck(path.node, path.node.source.value, ['*']); },
    ImportExpression(path) {
      const evaluated = path.get('source').evaluate();
      const name = evaluated.confident ? evaluated.value : text(path.node.source);
      moduleCheck(path.node, name, network.test(name) && !isTransport ? loaderCapabilities(path) : ['*']);
    },
    MemberExpression(path) {
      if (property(path.node) === 'getBuiltinModule' && !(path.parentPath.isCallExpression() && path.parentPath.node.callee === path.node)) fail(path.node, 'Cannot alias builtin module loader');
    },
    CallExpression(path) {
      const node = path.node;
      if (node.callee.type === 'Identifier' && loaders.has(node.callee.name)
        || node.callee.type === 'MemberExpression' && property(node.callee) === 'getBuiltinModule') {
        const name = text(node.arguments[0]);
        moduleCheck(node, name, network.test(name) && !isTransport ? loaderCapabilities(path) : ['*']);
      }
      if (node.callee.type === 'MemberExpression' && property(node.callee) === 'serve'
        && node.callee.object.name === 'Bun') fail(node, 'Bun server construction bypasses fixture transport');
    },
  });
  return { errors, imports };
}

export async function checkFixtureServers(root = fileURLToPath(new URL('../', import.meta.url))) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(f => /\.[cm]?[jt]sx?$/.test(f));
  const results = new Map(), sources = new Map();
  for (const file of new Set(files)) {
    const source = await readFile(resolve(root, file), 'utf8');
    sources.set(file, source);
    results.set(file, checkFixtureSource(source, file, { strictLoaders: file === transport }));
  }
  const errors = [...results.values()].flatMap(r => r.errors);
  const visited = new Set();
  function checkGraph(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = sources.get(file);
    if (source === undefined) { errors.push(`${file}:1: Fixture helper is outside scanned source`); return; }
    const result = checkFixtureSource(source, file);
    errors.push(...result.errors);
    if (file === transport && result.imports.length) errors.push(`${file}:1: Transport must not import local helpers`);
    for (const imported of result.imports) {
      const path = relative(root, resolve(root, dirname(file), imported));
      const target = [path, ...['.mjs', '.js', '.ts', '.tsx'].map(ext => path + ext), path.replace(/\.js$/, '.ts')].find(candidate => sources.has(candidate));
      if (target) checkGraph(target);
      else if (/\.[cm]?[jt]sx?$/.test(path) || !/\.\w+$/.test(path)) errors.push(`${file}:1: Unresolved fixture helper ${imported}`);
    }
  }
  for (const [file, result] of results) {
    if (file === transport || result.imports.some(path => /(?:fixture-http|proof-fixture-server)\.mjs$/.test(path))
      || result.errors.some(error => /Server construction|raw server|Bun server/.test(error))) checkGraph(file);
  }
  return [...new Set(errors)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = await checkFixtureServers(process.argv[2]);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Fixture server ownership check passed');
}
