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
  const engines = [];
  const namespaces = [];
  const safety = new Set();
  const violations = [];
  function safeArgs(path) {
    if (path.isIdentifier()) return safety.has(path.scope.getBinding(path.node.name));
    if (!path.isArrayExpression()) return false;
    const flags = new Set();
    for (const element of path.get('elements')) {
      if (element.isSpreadElement() && element.get('argument').isIdentifier() &&
        safety.has(element.scope.getBinding(element.node.argument.name))) {
        required.forEach(flag => flags.add(flag));
      } else if (element.isStringLiteral()) {
        if (required.some(flag => element.node.value.split('=')[0] === flag.split('=')[0] && element.node.value !== flag)) return false;
        flags.add(element.node.value);
      } else return false;
    }
    return required.every(flag => flags.has(flag));
  }
  function safeOptions(call) {
    if (!call.isCallExpression() || call.node.arguments.length !== 1) return false;
    const options = call.get('arguments.0');
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
  traverse(tree, {
    ImportDeclaration(path) {
      const module = path.node.source.value;
      for (const specifier of path.get('specifiers')) {
        const binding = path.scope.getBinding(specifier.node.local.name);
        if (playwrightModules.has(module)) {
          if (specifier.isImportDefaultSpecifier()) violations.push('default Playwright import is not auditable');
          if (specifier.isImportNamespaceSpecifier()) namespaces.push(binding);
          if (specifier.isImportSpecifier() && (specifier.node.imported.name || specifier.node.imported.value) === 'chromium') engines.push(binding);
        }
        if (specifier.isImportSpecifier() && specifier.node.imported.name === 'CHROMIUM_SAFETY_ARGS' &&
          resolve(dirname(resolve(file)), module) === safetyModule) safety.add(binding);
      }
    },
    CallExpression(path) {
      if (t.isIdentifier(path.node.callee, { name: 'require' }) && path.node.arguments.some(arg => t.isStringLiteral(arg) && playwrightModules.has(arg.value))) {
        violations.push('dynamic Playwright import is not auditable');
      }
    },
    ImportExpression(path) {
      if (t.isStringLiteral(path.node.source) && playwrightModules.has(path.node.source.value)) violations.push('dynamic Playwright import is not auditable');
    },
    ExportNamedDeclaration(path) {
      if (path.node.source && playwrightModules.has(path.node.source.value)) violations.push('Playwright re-export is not auditable');
    },
    ExportAllDeclaration(path) {
      if (playwrightModules.has(path.node.source.value)) violations.push('Playwright re-export is not auditable');
    },
  });
  function checkReference(receiver) {
    const method = receiver.parentPath;
    if (!method.isMemberExpression() || method.node.computed || method.node.object !== receiver.node ||
      !t.isIdentifier(method.node.property, { name: 'launch' }) || !method.parentPath.isCallExpression() ||
      method.parentPath.node.callee !== method.node || !safeOptions(method.parentPath)) {
      violations.push('Chromium reference must be a direct launch with verified args');
    }
  }
  for (const binding of engines) binding.referencePaths.forEach(checkReference);
  for (const binding of namespaces) {
    for (const reference of binding.referencePaths) {
      const member = reference.parentPath;
      if (member.isMemberExpression() && !member.node.computed && member.node.object === reference.node &&
        t.isIdentifier(member.node.property, { name: 'chromium' })) checkReference(member);
      else violations.push('Playwright namespace escapes direct Chromium launch');
    }
  }
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
