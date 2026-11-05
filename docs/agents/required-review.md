# Required pull request review

GitHub requires one native pull request approval in addition to green source CI.
The CARR review App (`doctorcre-carr-review[bot]`) submits the independent
reviewer's verdict. GitHub dismisses stale approvals on push and requires
approval of the latest push.

Reviewers write a verdict file beginning with `VERDICT: APPROVE` or
`VERDICT: CHANGES`, `Reviewed-SHA: <full SHA>`, and `Reviewer: <name>`.
The coordinator submits it from carr-system using `ops/review-submit.py` with
`--repository jbookout/doctorcre-app`, `--reviewed-sha`, and `--body-file`.
The authoring job never approves its own change. The submission helper checks
that the inspected SHA still matches the PR head before posting the review.

GitHub enforces approval directly. There is no custom approval status or
Actions variable to configure. Card lines remain dispatch metadata; PR title
checks and Card admission are not duplicated in CI.
