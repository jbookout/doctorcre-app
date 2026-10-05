import assert from 'node:assert/strict';
import test from 'node:test';
import { previewTarget } from '../scripts/preview-target.mjs';

test('hosted journeys accept only an isolated DoctorCRE version URL', () => {
  assert.equal(previewTarget('https://pr-123-doctorcre-app-pr-123.joe-bookout-carr-us.workers.dev/'),
    'https://pr-123-doctorcre-app-pr-123.joe-bookout-carr-us.workers.dev');
  assert.equal(previewTarget('https://abcdef12-doctorcre-app-pr-123.joe-bookout-carr-us.workers.dev'),
    'https://abcdef12-doctorcre-app-pr-123.joe-bookout-carr-us.workers.dev');
  for (const url of ['https://app.doctorcre.com', 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev',
    'http://pr-123-doctorcre-app-pr-123.joe-bookout-carr-us.workers.dev',
    'https://pr-123-doctorcre-app-pr-123.joe-bookout-carr-us.workers.dev/path',
    'https://pr-123-doctorcre-app-pr-123.joe-bookout-carr-us.workers.dev?mode=live'])
    assert.throws(() => previewTarget(url), /isolated PR preview/);
});
