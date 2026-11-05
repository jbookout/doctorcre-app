import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const audit = fileURLToPath(new URL('./chromium-safety.test.mjs', import.meta.url));
const shared = fileURLToPath(new URL('../scripts/chromium-safety-args.mjs', import.meta.url));
const imports = `import { chromium } from 'playwright';\nimport { CHROMIUM_SAFETY_ARGS } from ${JSON.stringify(shared)};\n`;
const flags = `'--use-mock-keychain', '--password-store=basic'`;
const fixtures = [
  ['shared direct', true, 'chromium.launch({ args: CHROMIUM_SAFETY_ARGS });'],
  ['shared spread', true, 'chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });'],
  ['shared spread with extra flag', true, `chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS, '--disable-gpu'] });`],
  ['complete literal', false, `chromium.launch({ args: [${flags}] });`],
  ['no args', false, 'chromium.launch();'],
  ['empty options', false, 'chromium.launch({});'],
  ['empty args', false, 'chromium.launch({ args: [] });'],
  ['missing password', false, `chromium.launch({ args: ['--use-mock-keychain'] });`],
  ['missing keychain', false, `chromium.launch({ args: ['--password-store=basic'] });`],
  ['different constant', false, 'const other = []; chromium.launch({ args: [...other] });'],
  ['comment direct', false, 'chromium.launch({ /* args: CHROMIUM_SAFETY_ARGS, */ args: [] });'],
  ['string direct', false, `chromium.launch({ note: 'args: CHROMIUM_SAFETY_ARGS,', args: [] });`],
  ['comment spread', false, 'chromium.launch({ /* args: [...CHROMIUM_SAFETY_ARGS] */ args: [] });'],
  ['string spread', false, `chromium.launch({ note: 'args: [...CHROMIUM_SAFETY_ARGS]', args: [] });`],
  ['overridden direct', false, 'chromium.launch({ args: CHROMIUM_SAFETY_ARGS, args: [] });'],
  ['overridden spread', false, 'chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS], args: [] });'],
  ['spread override', false, 'chromium.launch({ args: CHROMIUM_SAFETY_ARGS, ...{ args: [] } });'],
  ['aliased import', false, `import { chromium as engine } from 'playwright'; engine.launch({ args: [] });`],
  ['aliased method', false, 'const launch = chromium.launch; launch({ args: [] });'],
  ['bound method', false, 'const launch = chromium.launch.bind(chromium); launch({ args: [] });'],
  ['wrapper', false, 'function open(opts) { return chromium.launch(opts); } open({ args: [] });'],
  ['destructured wrapper', false, 'const { launch } = chromium; function open(opts) { return launch(opts); } open({ args: [] });'],
  ['namespace unsafe', false, `import * as pw from 'playwright'; pw.chromium.launch({ args: [] });`],
  ['computed method', false, `chromium['launch']({ args: [] });`],
  ['unknown spread', false, 'const extra = []; chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS, ...extra] });'],
  ['conflicting flag', false, `chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS, '--password-store=secret-service'] });`],
  ['shadowed shared', false, 'function open(CHROMIUM_SAFETY_ARGS) { chromium.launch({ args: CHROMIUM_SAFETY_ARGS }); } open([]);'],
  ['fake shared', false, `const CHROMIUM_SAFETY_ARGS = []; chromium.launch({ args: CHROMIUM_SAFETY_ARGS });`, false],
  ['wrong shared import', false, `import { CHROMIUM_SAFETY_ARGS } from './fake.mjs'; chromium.launch({ args: CHROMIUM_SAFETY_ARGS });`, false],
  ['mutated spread', false, 'chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS].slice(0, 0) });'],
  ['dynamic import', false, `const { chromium: engine } = await import('playwright'); engine.launch({ args: [] });`],
  ['require import', false, `const { chromium: engine } = require('playwright'); engine.launch({ args: [] });`],
  ['re-export', false, `export { chromium as engine } from 'playwright';`],
  ['namespace complete', false, `import * as pw from 'playwright'; pw.chromium.launch({ args: [${flags}] });`],
  ['alias complete', false, `import { chromium as engine } from 'playwright-core'; engine.launch({ args: [${flags}] });`],
  ['variable dynamic', false, "const moduleName = 'playwright'; const { chromium: engine } = await import(moduleName); function open() { return engine.launch({ args: [] }); } open();"],
  ['template dynamic', false, 'const { chromium: engine } = await import(`playwright`); function open() { return engine.launch({ args: [] }); } open();'],
  ['concatenated dynamic', false, "const { chromium: engine } = await import('play' + 'wright'); function open() { return engine.launch({ args: [] }); } open();"],
  ['variable require', false, "const moduleName = 'playwright'; const { chromium: engine } = require(moduleName); function open() { return engine.launch({ args: [] }); } open();"],
  ['re-exported module', false, "import { engine } from './re-export.mjs'; function open() { return engine.launch({ args: [] }); } open();"],
  ['unknown alias', false, 'const engine = getBrowser(); function open() { return engine.launch({ args: [] }); } open();'],
  ['unknown namespace', false, "import * as pw from './browser.mjs'; const engine = pw.chromium; function open() { return engine.launch({ args: [] }); } open();"],
  ['createRequire variable', false, "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); const moduleName = 'playwright'; const { chromium: engine } = load(moduleName); function open() { return engine.launch({ args: [] }); } open();"],
  ['unknown persistent launch', false, 'getBrowser().launchPersistentContext("/tmp/profile", { args: [] });'],
  ['unknown connection', false, 'getBrowser().connect({ args: [] });'],
  ['unknown escaped method', false, 'const start = getBrowser().launch; start({ args: [] });'],
  ['unknown safe spread', true, 'getBrowser().launch({ args: [...CHROMIUM_SAFETY_ARGS] });'],
  ['local connection', true, 'const socket = { connect() { return 1; } }; socket.connect();'],
  ['local factory connection', true, 'function setup() { return { connect: () => true }; } const socket = setup(); socket.connect();'],
  ['two launches', false, 'chromium.launch({ args: CHROMIUM_SAFETY_ARGS }); chromium.launch({ args: [] });'],
];

for (const [name, accepted, source, useShared = true] of fixtures) {
  test(`repository safety audit ${accepted ? 'accepts' : 'rejects'} ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'chromium-audit-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, 'fixture.mjs'), (useShared ? imports : `import { chromium } from 'playwright';\n`) + source);
      execFileSync('git', ['add', 'fixture.mjs'], { cwd: root });
      const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=every Chromium launch', audit], {
        cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, accepted ? 0 : 1, result.stdout + result.stderr);
      if (!accepted) assert.match(result.stdout, /Chromium launches must supply/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
