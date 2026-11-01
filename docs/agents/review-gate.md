# Native App review gate

The required `review-gate` status reads native reviews from the configured GitHub
App. Review bodies and issue comments do not grant approval. The workflow runs
trusted default-branch code for automatic PR, review, and merge-group events.
Manual dispatch checks out the selected workflow revision.

## Review policy

Set the repository Actions variable `CARR_REVIEW_APP_LOGIN` to
`doctorcre-carr-review[bot]`. A review-required PR passes only when that bot's
latest decisive native review is `APPROVED` at the exact PR head. The reviewer
must have GitHub user type `Bot` and differ from the PR author. A newer
`CHANGES_REQUESTED` or `DISMISSED` review replaces approval. `COMMENTED` and
`PENDING` reviews do not replace a decision. A current-head request for changes
also blocks the small-diff exemption.

The existing app exemption covers complete, safe diffs with net additions of at
most 150 lines. Existing risky paths and newly added files under `ops/`,
`scripts/`, or `.github/workflows/` require review. Large Markdown-only changes
have no separate exemption. A missing App variable blocks review-required PRs;
a configured human login blocks every PR. Human-authored PRs need a canonical
`Card: WR<number>.S<number>.J<number>` body line. Skip-CI markers in the PR title
or auto-merge commit title or message always fail.

Reviewers submit native `APPROVE` or `REQUEST_CHANGES` reviews through the review
App's installation on `jbookout/doctorcre-app`, with `commit_id` set to the full
SHA they inspected. The submitter must re-read the PR head before submission.
App authentication stays outside Actions. This repository does not store a
private key or install a second credential mechanism. The current CARR submitter
is pinned to `DoctorCRE/carr-system` and cannot submit app reviews unchanged.

## Squash queue behavior

The gate maps every comparison commit to a native `mergeQueue.entries`
`headCommit.oid`, then evaluates the corresponding PR at its original
`headRefOid`. This follows [carr-system PR 2863](https://github.com/DoctorCRE/carr-system/pull/2863),
whose squash commits had no original-commit PR association. Every constituent
must pass. Unknown commits, incomplete pagination, moved PR heads, or a changed
queue snapshot fail the group. The group is never approved unconditionally.

## Rollout dependencies

All setup steps are required before the coordinator lands this change.

1. Grant the review App access to `jbookout/doctorcre-app` with Pull requests read and write.
2. Set `CARR_REVIEW_APP_LOGIN` to `doctorcre-carr-review[bot]` in the app repository's Actions variables.
3. Configure the trusted App submitter for this repository and submit an independent current-head review.
4. Dispatch Review gate on the reviewed branch and confirm its `review-gate` status succeeds.

The existing main ruleset already requires Actions-origin `review-gate` and
`test`. It needs no new required status. Installation access and submitter
readiness must be verified by the coordinator; offline fixtures do not prove
those effects. If GitHub refuses branch dispatch before the new trigger reaches
main, report that bootstrap dependency rather than bypassing the required gate.
After rollout, automatic events use the new default-branch gate. During rollout,
the default branch still uses the old gate until this PR lands.

The optional manual input `queue_head_sha` rechecks a live merge group through
the same policy. It requires the group's full lowercase SHA and refuses a group
that no longer maps to the live queue.

## Offline verification

Run `python3 ops/review-gate-selftest.py`. Its synthetic PRs and queue entries
exercise native identity, head binding, review states, metadata freshness,
squash groups, pagination, and status publication. `node --test test/review-gate.test.mjs` runs the same selftest in the candidate-head CI suite.
