import test from 'node:test';
import { journeyEngine } from '../tests/journeys/phone-engine.mjs';
import { journeyProfiles } from '../tests/journeys/phone-profiles.mjs';
import assert from 'node:assert/strict';
import { assertNativeJourneys, requiredNativeEntries } from '../scripts/browser-proof-contract.mjs';

test('product proof refuses a missing, skipped or retried phone journey', () => {
  const targets = ['chromium', 'iphone', 'small-android'];
  const results = targets.flatMap(targetId => requiredNativeEntries.map(row => ({
    testId: `${row.file}::${encodeURIComponent(row.title)}`, targetId,
    selected: true, status: 'passed', attempts: [{}],
  })));
  assertNativeJourneys(results);
  assert.throws(() => assertNativeJourneys(results.filter(row => row.targetId !== 'small-android')), /small-android/);
  const iphone = results.findIndex(row => row.targetId === 'iphone');
  assert.throws(() => assertNativeJourneys(results.filter((_, i) => i !== iphone)), /iphone/);
  for (const change of [{ status: 'skipped' }, { selected: false }, { attempts: [{}, {}] }]) {
    assert.throws(() => assertNativeJourneys(results.map((row, i) => i === iphone ? { ...row, ...change } : row)), /iphone/);
  }
});

test('a phone target cannot silently lose mobile or touch emulation', () => {
  const iphone = journeyProfiles.find(profile => profile.name === 'iphone');
  for (const change of [{ hasTouch: false }, { isMobile: false }])
    assert.throws(() => journeyEngine({ ...iphone, ...change }), /Phone profile/);
});
