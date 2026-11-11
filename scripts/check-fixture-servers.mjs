import { build } from 'esbuild';
import { uiAssets } from './ui-bundle.mjs';
import { parseSync, traverse } from '@babel/core';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const network = /^(?:node:)?(?:https?|http2|net|tls)$/;
const constructors = new Set(['createServer', 'createSecureServer', 'Server', 'Http2Server', 'Http2SecureServer']);
const transport = 'scripts/fixture-http.mjs';
const text = node => node?.type === 'StringLiteral' ? node.value
  : node?.type === 'BinaryExpression' && node.operator === '+' && typeof text(node.left) === 'string' && typeof text(node.right) === 'string'
    ? text(node.left) + text(node.right) : undefined;
const property = node => node.computed ? text(node.property) : node.property?.name;

function finiteModules(path, seen = new Set()) {
  if (!path?.node || seen.has(path.node)) return;
  const next = new Set(seen).add(path.node);
  const evaluated = path.evaluate();
  if (evaluated.confident && typeof evaluated.value === 'string') return [evaluated.value];
  if (path.isMemberExpression() && !path.node.computed && path.node.property.name === 'href') {
    const object = path.get('object');
    if (object.isNewExpression() && object.node.callee.name === 'URL' && !object.scope.getBinding('URL')
      && object.get('arguments.1').matchesPattern('import.meta.url')) return finiteModules(object.get('arguments.0'), next);
  }
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (binding?.constant && binding.path.isVariableDeclarator()) return finiteModules(binding.path.get('init'), next);
    if (binding?.kind === 'param' && binding.constant) {
      const fn = binding.path.parentPath;
      if (!fn.isArrowFunctionExpression() || !fn.parentPath.isVariableDeclarator()) return;
      const index = fn.node.params.indexOf(binding.path.node);
      const owner = fn.parentPath;
      const callable = owner.scope.getBinding(owner.node.id.name);
      if (!callable?.constant || !callable.referencePaths.length) return;
      const values = [];
      for (const reference of callable.referencePaths) {
        const call = reference.parentPath;
        if (!call.isCallExpression() || call.node.callee !== reference.node) return;
        const argument = finiteModules(call.get(`arguments.${index}`), next);
        if (!argument) return;
        values.push(...argument);
      }
      return [...new Set(values)];
    }
  }
  if (path.isConditionalExpression()) {
    const left = finiteModules(path.get('consequent'), next), right = finiteModules(path.get('alternate'), next);
    if (left && right) return [...new Set([...left,...right])];
  }
  if (path.isTemplateLiteral()) {
    let prefix = '';
    for (let index = 0; index < path.node.quasis.length; index++) {
      const literal = path.node.quasis[index].value.cooked;
      if (literal == null) return;
      prefix += literal;
      if (prefix.includes('?') && /^(?:\.|\/|https?:\/\/)/.test(prefix)) return [prefix.split('?')[0]];
      if (index < path.node.expressions.length) {
        const part = finiteModules(path.get(`expressions.${index}`), next);
        if (!part || part.length !== 1) return;
        prefix += part[0];
      }
    }
    return [prefix];
  }
  if (path.isCallExpression() && !path.node.arguments.length && path.get('callee').isIdentifier()) {
    const binding = path.scope.getBinding(path.node.callee.name);
    const init = binding?.constant && binding.path.isVariableDeclarator() && binding.path.get('init');
    if (init && init.isArrowFunctionExpression() && !init.node.params.length && !init.get('body').isBlockStatement())
      return finiteModules(init.get('body'), next);
  }
}

export function checkFixtureSource(source, filename = 'fixture.mjs', { strictLoaders = true, transportDependency = false, resolvedLoads = new Map() } = {}) {
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
    if (name.startsWith('.') || name.startsWith('/')) imports.push(name.split(/[?#]/)[0]);
    if (name.startsWith('.') && names.some(name => constructors.has(name))) fail(node, 'Cannot import a raw server factory outside the descriptor transport');
    if (/^(?:express|serve-static|send|sirv|http-server|fastify|koa|connect)$/.test(name)) fail(node, 'Static server packages bypass fixture transport');
    if ((isTransport || transportDependency) && /^(?:node:)?fs(?:\/|$)/.test(name)) fail(node, 'Fixture transport cannot import filesystem APIs');
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
        if (names.filter(Boolean).some(n => !['startFixture', 'startWorkerFixture', 'fixtureKey'].includes(n))) fail(path.node, 'Only descriptor transport exports are allowed');
      }
    },
    ExportDefaultDeclaration(path) { if (isTransport) fail(path.node, 'Default transport exports are forbidden'); },
    ExportAllDeclaration(path) { if (isTransport) fail(path.node, 'Transport re-exports are forbidden'); moduleCheck(path.node, path.node.source.value, ['*']); },
    ImportExpression(path) {
      for (const name of (resolvedLoads.has(path.node.start) ? [resolvedLoads.get(path.node.start)] : finiteModules(path.get('source'))) || [undefined])
        moduleCheck(path.node, name, network.test(name) && !isTransport ? loaderCapabilities(path) : ['*']);
    },
    ReferencedIdentifier(path) {
      if (loaders.has(path.node.name)
        && !(path.parentPath.isMemberExpression() && path.parentPath.node.object === path.node && property(path.parentPath.node) === 'resolve')
        && !(path.parentPath.isCallExpression() && path.parentPath.node.callee === path.node)) fail(path.node, 'Cannot alias module loader');
    },
    OptionalMemberExpression(path) {
      if (!isTransport && constructors.has(property(path.node))) fail(path.node, 'Server construction belongs to scripts/fixture-http.mjs');
      if (property(path.node) === 'getBuiltinModule') fail(path.node, 'Optional builtin module capability is not verified');
    },
    MemberExpression(path) {
      if (!isTransport && constructors.has(property(path.node))) fail(path.node, 'Server construction belongs to scripts/fixture-http.mjs');
      if (property(path.node) === 'getBuiltinModule' && !(path.parentPath.isCallExpression() && path.parentPath.node.callee === path.node)) fail(path.node, 'Cannot alias builtin module loader');
    },
    CallExpression(path) {
      const node = path.node;
      if (node.callee.type === 'Identifier' && loaders.has(node.callee.name)
        || node.callee.type === 'MemberExpression' && ['require', 'getBuiltinModule'].includes(property(node.callee))) {
        const name = text(node.arguments[0]);
        moduleCheck(node, name, network.test(name) && !isTransport ? loaderCapabilities(path) : ['*']);
      }
      if (node.callee.type === 'MemberExpression' && property(node.callee) === 'serve'
        && node.callee.object.name === 'Bun') fail(node, 'Bun server construction bypasses fixture transport');
    },
  });
  return { errors, imports };
}

// Resolve data modules only when their bytes originate in a declared esbuild
// operation. Rebuild the actual graph; a data URL alone proves nothing.
async function generatedLoads(source, filename, root) {
  const loads = new Map(), modules = new Map();
  let ast;
  try { ast = parseSync(source, { configFile: false, babelrc: false, sourceType: 'module' }); }
  catch { return { loads, modules }; }
  const pending = [];
  traverse(ast, { ImportExpression(path) {
    const value = path.get('source');
    if (!value.isTemplateLiteral() || value.node.quasis.length !== 2
      || value.node.quasis[0].value.cooked !== 'data:text/javascript;base64,' || value.node.quasis[1].value.cooked !== '') return;
    const encoded = value.get('expressions.0');
    if (!encoded.isCallExpression() || !encoded.get('callee').isMemberExpression()
      || property(encoded.node.callee) !== 'toString' || text(encoded.node.arguments[0]) !== 'base64') return;
    const buffer = encoded.get('callee.object');
    if (!buffer.isCallExpression() || !buffer.get('callee').matchesPattern('Buffer.from') || buffer.scope.getBinding('Buffer')) return;
    const output = buffer.get('arguments.0');
    if (!output.isMemberExpression() || !['text','contents'].includes(property(output.node))) return;
    const first = output.get('object');
    if (!first.isMemberExpression() || first.node.property.value !== 0) return;
    const files = first.get('object');
    if (!files.isMemberExpression() || property(files.node) !== 'outputFiles') return;
    const binding = files.scope.getBinding(files.node.object.name);
    if (!binding?.path.isVariableDeclarator() || binding.referencePaths.some(reference => {
      const member = reference.parentPath;
      return !member.isMemberExpression() || member.node.object !== reference.node || property(member.node) !== 'outputFiles'
        || !member.parentPath.isMemberExpression() || member.parentPath.node.property.value !== 0
        || !member.parentPath.parentPath.isMemberExpression()
        || !['text', 'contents'].includes(property(member.parentPath.parentPath.node))
        || !member.parentPath.parentPath.parentPath.isCallExpression()
        || !member.parentPath.parentPath.parentPath.get('callee').matchesPattern('Buffer.from');
    })) return;
    let call = binding.path.get('init');
    if (call.node && binding.constantViolations.length) return;
    if (!call.node && binding.constantViolations.length === 1) call = binding.constantViolations[0].get('right');
    if (call.isAwaitExpression()) call = call.get('argument');
    if (!call.isCallExpression()) return;
    if (call.get('callee').isMemberExpression() && property(call.node.callee) === 'rebuild') {
      const compiler = call.scope.getBinding(call.node.callee.object.name);
      if (!compiler?.constant || compiler.referencePaths.some(reference => {
        const member = reference.parentPath;
        return !member.isMemberExpression() || !['rebuild','cancel','dispose'].includes(property(member.node))
          || !member.parentPath.isCallExpression() || member.parentPath.node.callee !== member.node
          || member.parentPath.node.arguments.length;
      })) return;
      call = compiler.path.get('init');
      if (call?.isAwaitExpression()) call = call.get('argument');
    }
    if (!call?.isCallExpression() || !call.get('callee').isIdentifier()) return;
    const compilerImport = call.scope.getBinding(call.node.callee.name)?.path;
    if (!compilerImport?.isImportSpecifier() || compilerImport.parent.source.value !== 'esbuild'
      || !['build','context'].includes(compilerImport.node.imported.name)) return;
    const options = call.get('arguments.0');
    if (!options.isObjectExpression() || options.node.properties.some(p => p.type !== 'ObjectProperty' || p.computed)) return;
    if (new Set(options.node.properties.map(p => p.key.name)).size !== options.node.properties.length) return;
    const fields = new Map(options.get('properties').filter(p => p.isObjectProperty() && !p.node.computed).map(p => [p.node.key.name, p.get('value')]));
    if (fields.get('bundle')?.evaluate().value !== true || fields.get('write')?.evaluate().value !== false
      || fields.get('format')?.evaluate().value !== 'esm' || fields.get('platform')?.evaluate().value !== 'node'
      || [...fields.keys()].some(key => !['entryPoints','stdin','bundle','write','platform','format'].includes(key))) return;
    let inputs;
    if (fields.has('entryPoints')) {
      const entry = fields.get('entryPoints').evaluate();
      if (!entry.confident || !Array.isArray(entry.value) || !entry.value.every(p => typeof p === 'string')) return;
      inputs = { entryPoints: entry.value };
    } else {
      const stdin = fields.get('stdin');
      if (!stdin?.isObjectExpression() || stdin.node.properties.some(p => p.type !== 'ObjectProperty' || p.computed || !['contents', 'resolveDir'].includes(p.key.name))) return;
      if (new Set(stdin.node.properties.map(p => p.key.name)).size !== stdin.node.properties.length) return;
      const directory = stdin.get('properties').find(p => p.node.key.name === 'resolveDir')?.get('value');
      if (!directory?.isCallExpression() || !directory.get('callee').isIdentifier()) return;
      const urlImport = directory.scope.getBinding(directory.node.callee.name)?.path;
      const url = directory.get('arguments.0');
      if (!urlImport?.isImportSpecifier() || urlImport.node.imported.name !== 'fileURLToPath' || urlImport.parent.source.value !== 'node:url'
        || !url.isNewExpression() || url.node.callee.name !== 'URL' || text(url.node.arguments[0]) !== '../'
        || !url.get('arguments.1').matchesPattern('import.meta.url') || dirname(filename) !== 'scripts') return;
      const contents = stdin.get('properties').find(p => p.isObjectProperty() && p.node.key.name === 'contents')?.get('value').evaluate();
      if (!contents?.confident || typeof contents.value !== 'string') return;
      inputs = { stdin: { contents: contents.value, resolveDir: root } };
    }
    const key = `./__generated_fixture_${path.node.start}.mjs`;
    loads.set(path.node.start, key);
    pending.push(build({ ...inputs, absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'esm' })
      .then(result => modules.set(relative(root, resolve(root, dirname(filename), key)), result.outputFiles[0].text)));
  } });
  await Promise.all(pending);
  return { loads, modules };
}

export async function checkFixtureServers(root = fileURLToPath(new URL('../', import.meta.url))) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(f => /\.[cm]?[jt]sx?$|\.json$/.test(f));
  const results = new Map(), sources = new Map(), loadResolutions = new Map();
  for (const file of new Set(files)) {
    const source = await readFile(resolve(root, file), 'utf8');
    sources.set(file, source);
    if (file.endsWith('.json')) { JSON.parse(source); continue; }
    const generated = await generatedLoads(source, file, root);
    loadResolutions.set(file, generated.loads);
    for (const [key, contents] of generated.modules) {
      sources.set(key, contents);
      results.set(key, checkFixtureSource(contents, key));
    }
    results.set(file, checkFixtureSource(source, file, { strictLoaders: file === transport, resolvedLoads: generated.loads }));
  }
  if (sources.has('scripts/ui-bundle.mjs')) {
    try {
      for (const [file, bytes] of await uiAssets(async file => {
        const source = sources.get(file);
        if (source === undefined) throw new Error(`Missing generated module input ${file}`);
        return source;
      })) {
        const source = bytes.toString();
        sources.set(file,source);
        results.set(file,checkFixtureSource(source,file,{strictLoaders:false}));
      }
    } catch (error) { return [`scripts/ui-bundle.mjs:1: Generated fixture graph failed: ${error.message}`]; }
  }
  const errors = [...results.values()].flatMap(r => r.errors);
  const transportVisited = new Set();
  function checkTransportGraph(file) {
    if (file.endsWith('.json')) return;
    if (transportVisited.has(file)) return;
    transportVisited.add(file);
    const source = sources.get(file);
    if (source === undefined) { errors.push(`${file}:1: Unresolved transport dependency`); return; }
    const result = checkFixtureSource(source, file, { transportDependency: true });
    errors.push(...result.errors);
    for (const imported of result.imports) {
      const path = relative(root, resolve(root, imported.startsWith('/') ? '.' + imported : dirname(file), imported.startsWith('/') ? '' : imported));
      const target = [path, ...['.mjs', '.js', '.ts', '.tsx'].map(ext => path + ext), path.replace(/\.js$/, '.ts')].find(candidate => sources.has(candidate));
      if (target) checkTransportGraph(target);
      else if (/\.[cm]?[jt]sx?$/.test(path) || !/\.\w+$/.test(path)) errors.push(`${file}:1: Unresolved transport dependency ${imported}`);
    }
  }
  const visited = new Set();
  function checkGraph(file) {
    if (file.endsWith('.json')) return;
    if (visited.has(file)) return;
    visited.add(file);
    const source = sources.get(file);
    if (source === undefined) { errors.push(`${file}:1: Fixture helper is outside scanned source`); return; }
    const result = checkFixtureSource(source, file, { resolvedLoads: loadResolutions.get(file) });
    errors.push(...result.errors);
    if (file === transport && result.imports.some(name => !['../src/worker.js', '../js/routes.js', './qa-fixture-dispatch.mjs', './work-inventory-fixture.mjs', './atlas-fixture.mjs'].includes(name))) errors.push(`${file}:1: Transport must not import local helpers`);
    if (file === transport) checkTransportGraph(file);
    for (const imported of result.imports) {
      const path = relative(root, resolve(root, imported.startsWith('/') ? '.' + imported : dirname(file), imported.startsWith('/') ? '' : imported));
      const target = [path, ...['.mjs', '.js', '.ts', '.tsx'].map(ext => path + ext), path.replace(/\.js$/, '.ts')].find(candidate => sources.has(candidate));
      if (target) checkGraph(target);
      else if (/\.[cm]?[jt]sx?$/.test(path) || !/\.\w+$/.test(path)) errors.push(`${file}:1: Unresolved fixture helper ${imported}`);
    }
  }
  for (const [file, result] of results) {
    if (file === transport || result.imports.some(path => /(?:fixture-http)\.mjs$/.test(path))
      || result.errors.some(error => /Server construction|raw server|Bun server/.test(error))) checkGraph(file);
  }
  return [...new Set(errors)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = await checkFixtureServers(process.argv[2]);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Fixture server ownership check passed');
}
