import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { journeyProfiles } from '../tests/journeys/phone-profiles.mjs';
import { TOUCH_LAYOUT } from '../js/touch-layout.js';
import { requiredNativeEntries, requiredTargets, validateNativeCompletion } from '../scripts/browser-proof-contract.mjs';

const commit = 'a'.repeat(40);
const native = rows => ({ run: { id: 'run', vcs: { commit, dirty: false }, exitCode: 0, status: 'passed', results: rows } });
const results = requiredTargets.flatMap(targetId => requiredNativeEntries.map(row => ({
  testId: `${row.file}::${encodeURIComponent(row.title)}`, file: row.file, targetId,
  selected: true, status: 'passed', attempts: [{}],
})));

test('every required touch width is a configured journey target', () => {
  assert.deepEqual(journeyProfiles.map(profile => profile.name), requiredTargets);
  const widths = journeyProfiles.filter(profile => profile.hasTouch).map(profile => profile.viewport.width);
  for (const width of [320, 390, 768]) assert.ok(widths.includes(width), `${width}px touch profile`);
});

test('product proof refuses a missing, skipped or retried journey on any target', () => {
  assert.equal(validateNativeCompletion(native(results), commit), results.length);
  for (const target of requiredTargets) {
    assert.throws(() => validateNativeCompletion(native(results.filter(row => row.targetId !== target)), commit), new RegExp(target));
    const index = results.findIndex(row => row.targetId === target);
    assert.throws(() => validateNativeCompletion(native(results.filter((_, i) => i !== index)), commit), new RegExp(target));
    for (const change of [{ selected: false }, { targetId: 'other' }])
      assert.throws(() => validateNativeCompletion(native(results.map((row, i) => i === index ? { ...row, ...change } : row)), commit), new RegExp(target));
    for (const change of [{ status: 'skipped' }, { attempts: [{}, {}] }])
      assert.throws(() => validateNativeCompletion(native(results.map((row, i) => i === index ? { ...row, ...change } : row)), commit), /incomplete/);
  }
});

test('every stylesheet switches to the touch layout with the shared query', async () => {
  const css = new URL('../css/', import.meta.url);
  let uses = 0;
  for (const name of await readdir(css)) {
    const source = await readFile(new URL(name, css), 'utf8');
    for (const [, query] of source.matchAll(/@media ?([^{]*\b76[01]px[^{]*)\{/g)) {
      uses++;
      assert.ok(query.trim() === TOUCH_LAYOUT || query.includes(`(not (${TOUCH_LAYOUT.split(',')[1]}))`), `${name}: ${query}`);
    }
  }
  assert.ok(uses >= 17);
});

test('screen evidence stays in run output and is never tracked as scratch', () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const scratch = git('ls-files', '--', '_to_delete', '*mobile-a11y-evidence*').split('\n').filter(Boolean);
  assert.deepEqual(scratch.filter(path => /mobile-a11y-evidence|\.(png|jpe?g|webp)$/i.test(path)), []);
  for (const path of ['mobile-a11y-evidence/iphone-home.png', '_to_delete/mobile-a11y-evidence/iphone-home.png', '.e2e/artifacts/home.png'])
    assert.equal(git('check-ignore', '--no-index', path).trim(), path, `${path} is ignored`);
});
