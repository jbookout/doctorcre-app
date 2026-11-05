import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync, traverse, types as t } from '@babel/core';

const required = ['--use-mock-keychain', '--password-store=basic'];

const safetyModule = fileURLToPath(new URL('../scripts/chromium-safety-args.mjs', import.meta.url));
const harnessModule = fileURLToPath(new URL('./browser-harness.mjs', import.meta.url));
const harnessHash = '2aac6eda21d70ca9e7dc0543e6e56e0818107aae054d186d05113a6126bcd98a';
const playwrightModules = new Set(['playwright', 'playwright-core', '@playwright/test']);

function auditLaunches(file, source) {
  if (resolve(file) === harnessModule) {
    return createHash('sha256').update(source).digest('hex') === harnessHash ? [] : ['shared harness changed; audit its engine dispatch and update its pin'];
  }
  let tree;
  try {
    tree = parseSync(source, { configFile: false, babelrc: false, sourceType: 'unambiguous',
      parserOpts: { plugins: /\.[cm]?tsx?$/.test(file) ? [['typescript', { dts: /\.d\.[cm]?ts$/.test(file) }], ...(/tsx$/.test(file) ? ['jsx'] : [])] : ['jsx'] } });
  } catch {
    return ['source cannot be parsed'];
  }
  const safety = new Set();
  const harness = new Set();
  const violations = [];
  const methods = new Set(['launch', 'launchPersistentContext', 'connect']);
  const writtenMethods = new Set();
  function memberName(node) {
    return !node.computed && t.isIdentifier(node.property) ? node.property.name :
      t.isStringLiteral(node.property) ? node.property.value : undefined;
  }
  function safeArgs(path) {
    if (path.isIdentifier()) return safety.has(path.scope.getBinding(path.node.name));
    if (!path.isArrayExpression()) return false;
    const elements = path.get('elements');
    if (!elements[0]?.isSpreadElement() || !elements[0].get('argument').isIdentifier() || !safeArgs(elements[0].get('argument'))) return false;
    return elements.slice(1).every(element => element.isStringLiteral() &&
      !required.some(flag => element.node.value.split('=')[0] === flag.split('=')[0] && element.node.value !== flag));
  }
  function safeOptions(call, name) {
    const index = name === 'launchPersistentContext' ? 1 : 0;
    if (!call.isCallExpression() || call.node.arguments.length !== index + 1 || call.node.arguments.some(arg => t.isSpreadElement(arg))) return false;
    const options = call.get(`arguments.${index}`);
    if (!options.isObjectExpression()) return false;
    let args;
    for (const property of options.get('properties')) {
      if (!property.isObjectProperty() || property.node.computed) return false;
      if ((property.node.key.name || property.node.key.value) === 'args') {
        if (args) return false;
        args = property.get('value');
      }
    }
    return !!args && safeArgs(args);
  }
  function initializer(path) {
    if (!path.isIdentifier()) return path;
    const binding = path.scope.getBinding(path.node.name);
    if (!binding?.constant || !binding.path.isVariableDeclarator() || !t.isIdentifier(binding.path.node.id)) return path;
    if (binding.referencePaths.some(reference => !reference.parentPath.isMemberExpression() || reference.parentPath.node.object !== reference.node)) return path;
    return binding.path.get('init');
  }
  function harnessReceiver(path, seen = new Set()) {
    if (!path?.isIdentifier() || seen.has(path.node)) return false;
    seen = new Set(seen).add(path.node);
    const binding = path.scope.getBinding(path.node.name);
    if (!binding?.constant) return false;
    if (harness.has(binding)) return true;
    const declaration = binding.path;
    if (declaration.isVariableDeclarator()) {
      if (declaration.parentPath.parentPath.isForOfStatement()) {
        const values = declaration.parentPath.parentPath.get('right');
        if (!values.isArrayExpression()) return false;
        const id = declaration.get('id');
        const index = id.isArrayPattern() ? id.node.elements.indexOf(binding.identifier) : -1;
        if (!id.isIdentifier() && index < 0) return false;
        return values.get('elements').every(value => harnessReceiver(index < 0 ? value :
          value.isArrayExpression() ? value.get(`elements.${index}`) : undefined, seen));
      }
      if (declaration.get('id').isIdentifier()) return harnessReceiver(declaration.get('init'), seen);
      const init = declaration.get('init');
      const imported = init.isAwaitExpression() ? init.get('argument') : init;
      const source = imported.isCallExpression() && imported.get('callee').isImport() ? imported.get('arguments.0') :
        imported.isImportExpression() ? imported.get('source') : undefined;
      return declaration.get('id').isObjectPattern() && source?.isStringLiteral() &&
        resolve(dirname(resolve(file)), source.node.value) === harnessModule &&
        declaration.get('id.properties').some(property => property.isObjectProperty() &&
          ['chromium', 'webkit'].includes(property.node.key.name) && property.node.value === path.scope.getBinding(path.node.name).identifier);
    }
    const fn = declaration.isFunctionDeclaration() ? declaration : declaration.getFunctionParent();
    if (!fn?.isFunctionDeclaration()) return false;
    const parameters = fn.get('params');
    let index = parameters.findIndex(parameter => parameter.node === declaration.node);
    let key;
    let fallback;
    if (index < 0 || !parameters[index].isIdentifier()) {
      index = parameters.findIndex(parameter => {
        const pattern = parameter.isAssignmentPattern() ? parameter.get('left') : parameter;
        if (!pattern.isObjectPattern()) return false;
        const property = pattern.get('properties').find(property => property.isObjectProperty() &&
          (property.node.value === binding.identifier || property.node.value.left === binding.identifier));
        if (!property) return false;
        key = property.node.key.name;
        if (property.get('value').isAssignmentPattern()) fallback = property.get('value.right');
        return true;
      });
    }
    const owner = fn.parentPath.scope.getBinding(fn.node.id.name);
    if (index < 0 || !owner?.constant || !owner.referencePaths.length) return false;
    return owner.referencePaths.every(reference => {
      const call = reference.parentPath;
      if (!call.isCallExpression() || call.node.callee !== reference.node) return false;
      let value = call.get(`arguments.${index}`);
      if (key && value?.node) {
        if (!value.isObjectExpression() || value.get('properties').some(property => !property.isObjectProperty() || property.node.computed)) return false;
        const matching = value.get('properties').filter(property => property.node.key.name === key);
        if (matching.length > 1) return false;
        value = matching[0]?.get('value');
      }
      return harnessReceiver(value?.node ? value : fallback, seen);
    });
  }
  function localMethod(receiver, name, seen = new Set()) {
    if (!receiver?.node || seen.has(receiver.node) || writtenMethods.has(name)) return false;
    seen.add(receiver.node);
    const value = initializer(receiver);
    if (value !== receiver) return localMethod(value, name, seen);
    if (value.isObjectExpression()) {
      const properties = value.get('properties');
      if (properties.some(property => property.isSpreadElement() || property.node.computed)) return false;
      const matching = properties.filter(property => (property.node.key.name || property.node.key.value) === name);
      return matching.length === 1 && (matching[0].isObjectMethod({ kind: 'method' }) ||
        matching[0].isObjectProperty() && (matching[0].get('value').isFunctionExpression() || matching[0].get('value').isArrowFunctionExpression()));
    }
    if (!value.isCallExpression() || !value.get('callee').isIdentifier()) return false;
    const binding = value.scope.getBinding(value.node.callee.name);
    if (!binding?.constant || !binding.path.isFunctionDeclaration() || binding.path.node.async || binding.path.node.generator) return false;
    const body = binding.path.get('body.body');
    const returns = [];
    binding.path.traverse({ ReturnStatement(path) {
      if (path.getFunctionParent() === binding.path) returns.push(path);
    } });
    return returns.length === 1 && body.at(-1) === returns[0] && localMethod(returns[0].get('argument'), name, seen);
  }
  function nativeAudio(receiver) {
    const oscillator = initializer(receiver);
    if (!oscillator.isCallExpression() || !t.isMemberExpression(oscillator.node.callee) ||
      memberName(oscillator.node.callee) !== 'createOscillator') return false;
    const audio = initializer(oscillator.get('callee.object'));
    return audio.isNewExpression() && t.isIdentifier(audio.node.callee, { name: 'AudioContext' }) &&
      !audio.scope.getBinding('AudioContext');
  }
  traverse(tree, {
    ImportDeclaration(path) {
      const module = path.node.source.value;
      for (const specifier of path.get('specifiers')) {
        const binding = path.scope.getBinding(specifier.node.local.name);
        if (!specifier.isImportSpecifier()) continue;
        const imported = specifier.node.imported.name || specifier.node.imported.value;
        if (imported === 'CHROMIUM_SAFETY_ARGS' && resolve(dirname(resolve(file)), module) === safetyModule) safety.add(binding);
        if (['chromium', 'webkit'].includes(imported) && resolve(dirname(resolve(file)), module) === harnessModule) harness.add(binding);
      }
    },
    'AssignmentExpression|UpdateExpression'(path) {
      const target = path.get(path.isAssignmentExpression() ? 'left' : 'argument');
      if (target.isMemberExpression()) writtenMethods.add(memberName(target.node));
    },
    ObjectPattern(path) {
      for (const property of path.get('properties')) {
        if (property.isObjectProperty() && methods.has(property.node.key.name || property.node.key.value)) {
          violations.push('browser methods cannot be destructured from an unproven receiver');
        }
      }
    },
    ExportNamedDeclaration(path) {
      if (path.node.source && playwrightModules.has(path.node.source.value)) violations.push('Playwright re-export is not auditable');
    },
    ExportAllDeclaration(path) {
      if (playwrightModules.has(path.node.source.value)) violations.push('Playwright re-export is not auditable');
    },
  });
  traverse(tree, {
    'MemberExpression|OptionalMemberExpression'(path) {
      const name = memberName(path.node);
      if (!methods.has(name)) return;
      const receiver = path.get('object');
      const call = path.parentPath;
      const direct = !path.node.computed && call.isCallExpression() && call.node.callee === path.node;
      const trustedHarness = name === 'launch' && harnessReceiver(receiver);
      if (direct && (trustedHarness || localMethod(receiver, name) || name === 'connect' && nativeAudio(receiver) || safeOptions(call, name))) return;
      violations.push('browser method must be a direct call with verified shared args or a proven local receiver');
    },
  });
  return violations;
}

test('the shared harness audit pin refuses changed engine dispatch', () => {
  const source = readFileSync(harnessModule, 'utf8');
  assert.deepEqual(auditLaunches(harnessModule, source), []);
  assert.notDeepEqual(auditLaunches(harnessModule, source.replace('...CHROMIUM_SAFETY_ARGS,', '')), []);
});

test('every Chromium launch explicitly supplies keychain safety arguments', async () => {
  const violations = [];
  const files = execFileSync('git', ['ls-files', '*.mjs', '*.js', '*.ts', '*.cjs', '*.mts', '*.cts', '*.jsx', '*.tsx'], { encoding: 'utf8' }).trim().split('\n');
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const reason of auditLaunches(file, source)) violations.push(`${file}: ${reason}`);
  }
  assert.deepEqual(violations, [], 'Chromium launches must supply CHROMIUM_SAFETY_ARGS');
  const { CHROMIUM_SAFETY_ARGS } = await import('../scripts/chromium-safety-args.mjs');
  assert.deepEqual([...CHROMIUM_SAFETY_ARGS], required);
  const { default: config } = await import('../playwright.config.ts');
  assert.deepEqual(config.use.launchOptions.args, required);
});

test('the shared Chromium harness passes safety args and preserves caller args', async () => {
  const calls = [];
  const key = Symbol.for('chromium-safety-stub');
  globalThis[key] = { launch: async options => {
    calls.push(options);
    return { close: async () => {} };
  } };
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'playwright') return {
      url: `data:text/javascript,${encodeURIComponent("export const chromium = globalThis[Symbol.for('chromium-safety-stub')]; export const webkit = {};")}`,
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  } });
  try {
    const { chromium } = await import('./browser-harness.mjs');
    await chromium.launch();
    await chromium.launch({ args: ['--disable-gpu'] });
    assert.deepEqual(calls.map(call => call.args), [required, [...required, '--disable-gpu']]);
  } finally {
    hooks.deregister();
    delete globalThis[key];
  }
});
