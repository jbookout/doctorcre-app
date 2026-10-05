import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNativeJourneys, requiredNativeEntries } from '../scripts/browser-proof-contract.mjs';

test('product proof refuses a missing, skipped or retried phone journey', () => {
  const targets = ['chromium', 'iphone', 'small-android'];
  const results = targets.flatMap(targetId => requiredNativeEntries.map(row => ({
    testId: `${row.file}::${encodeURIComponent(row.title)}`, targetId,
    selected: true, status: 'passed', attempts: [{}],
  })));
  assertNativeJourneys(results, targets);
  const iphone = results.findIndex(row => row.targetId === 'iphone');
  assert.throws(() => assertNativeJourneys(results.filter((_, i) => i !== iphone), targets), /iphone/);
  for (const change of [{ status: 'skipped' }, { selected: false }, { attempts: [{}, {}] }]) {
    assert.throws(() => assertNativeJourneys(results.map((row, i) => i === iphone ? { ...row, ...change } : row), targets), /iphone/);
  }
});
