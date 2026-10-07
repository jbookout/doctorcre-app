import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('the preview workflow builds the exact PR head, skips absent credentials, and owns closure', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pr-preview.yml', import.meta.url), 'utf8');
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, closed\]/);
  assert.match(workflow, /ref: \$\{\{ github.event.pull_request.head.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /head.repo.full_name == github.repository/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(workflow, /Preview skipped: add repository secret CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /run: npm run build/);
  assert.match(workflow, /run: npm run artifact:verify/);
  assert.match(workflow, /node scripts\/pr-preview.mjs upload/);
  assert.match(workflow, /node scripts\/pr-preview.mjs cleanup/);
  assert.match(workflow, /E2E_PREVIEW_URL: \$\{\{ needs.preview.outputs.version_url \}\}/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /upsertPreviewComment/);
  assert.doesNotMatch(workflow, /pull_request_target|wrangler deploy|versions deploy|triggers deploy|cf (?:build|deploy|dev)|secrets: inherit/);
});
