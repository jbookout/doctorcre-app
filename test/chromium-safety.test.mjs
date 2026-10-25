import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const required = ['--use-mock-keychain', '--password-store=basic'];

test('every Chromium launch explicitly supplies keychain safety arguments', async () => {
  const violations = [];
  const files = execFileSync('git', ['ls-files', '*.mjs', '*.js', '*.ts'], { encoding: 'utf8' }).trim().split('\n');
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!/import\s+(?:\{[^}]*\bchromium\b[^}]*\}|\*\s+as\s+\w+)\s+from\s*['"](?:playwright(?:-core)?|@playwright\/test)['"]/.test(source)) continue;
    for (const launch of source.matchAll(/\b\w+\.launch\(([^)]*)\)/g)) {
      if (!/args:\s*\[\s*\.\.\.CHROMIUM_SAFETY_ARGS/.test(launch[1])) violations.push(file);
    }
  }
  assert.deepEqual(violations, [], 'Chromium launches must supply CHROMIUM_SAFETY_ARGS');
  const { CHROMIUM_SAFETY_ARGS } = await import('../scripts/chromium-safety-args.mjs');
  assert.deepEqual([...CHROMIUM_SAFETY_ARGS], required);
  const { default: config } = await import('../playwright.config.ts');
  assert.deepEqual(config.use.launchOptions.args, required);
});

test('the shared Chromium harness passes safety args and preserves caller args', async () => {
  const { chromium: engine } = await import('playwright');
  const original = engine.launch;
  const calls = [];
  engine.launch = async options => {
    calls.push(options);
    return { close: async () => {} };
  };
  try {
    const { chromium } = await import('./browser-harness.mjs');
    await chromium.launch();
    await chromium.launch({ args: ['--disable-gpu'] });
    assert.deepEqual(calls.map(call => call.args), [required, [...required, '--disable-gpu']]);
  } finally {
    engine.launch = original;
  }
});
