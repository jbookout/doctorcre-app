import assert from 'node:assert/strict';
import test from 'node:test';
import { upsertPreviewComment } from '../scripts/preview-comment.mjs';

test('preview updates replace the one owned PR comment, preserving unrelated comments', async () => {
  const written = [];
  const github = {
    paginate: async () => [{ id: 1, user: { login: 'someone' }, body: '<!-- doctorcre-pr-preview -->' },
      { id: 2, user: { login: 'github-actions[bot]' }, body: '<!-- doctorcre-pr-preview --> old preview' }],
    rest: { issues: { listComments() {}, updateComment: async args => written.push(args), createComment: async () => assert.fail('duplicate comment') } },
  };
  await upsertPreviewComment(github, { owner: 'jbookout', repo: 'doctorcre-app' }, 123, 'Preview skipped: add CLOUDFLARE_API_TOKEN');
  assert.equal(written[0].comment_id, 2);
  assert.match(written[0].body, /CLOUDFLARE_API_TOKEN/);
  assert.match(written[0].body, /Synthetic fixtures/);
});

test('first preview creates a comment and a close replaces it with cleanup status', async () => {
  const written = [];
  const github = {
    paginate: async () => [],
    rest: { issues: { listComments() {}, createComment: async args => written.push(args) } },
  };
  await upsertPreviewComment(github, { owner: 'jbookout', repo: 'doctorcre-app' }, 123, 'Preview removed');
  assert.equal(written[0].issue_number, 123);
  assert.match(written[0].body, /Preview removed/);
});
