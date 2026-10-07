const marker = '<!-- doctorcre-pr-preview -->';

export async function upsertPreviewComment(github, repository, pr, status) {
  const comments = await github.paginate(github.rest.issues.listComments,
    { ...repository, issue_number: pr, per_page: 100 });
  const owned = comments.find(comment => comment.user?.login === 'github-actions[bot]' && comment.body?.includes(marker));
  const body = `${marker}\n### DoctorCRE PR preview\n\n${status}\n\nSynthetic fixtures only. Changes stay in browser memory; no production records are read or written.\n`;
  if (owned) await github.rest.issues.updateComment({ ...repository, comment_id: owned.id, body });
  else await github.rest.issues.createComment({ ...repository, issue_number: pr, body });
}
