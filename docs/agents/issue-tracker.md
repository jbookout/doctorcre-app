# Issue tracker: CARR Work Requests

DoctorCRE work is tracked as CARR Work Requests in the record layer. Use the
CARR connector's record verbs; this repository has no `run.sh` wrapper. The
application's authenticated, versioned contracts remain its runtime interface.
This setup does not add verbs to that contract or permit direct database access.

## Conventions

- **Create an issue**: `report-problem` with `situation`, `title`,
  `desired_outcome`, and `acceptance_criteria` as `[{id, text}]` (for example,
  `AC-1`). It captures a request without triaging or dispatching it.
- **Read an issue**: `work-request-card` with `work_request` set to its `WR-` ref.
- **List issues**: `current-work-requests` returns requests needing bounded
  human action; it is not a complete filtered backlog.
- **Triage**: propose the classification in [triage-labels.md](triage-labels.md).
  `review-and-triage` requires direct human authority; do not impersonate it.
- **Withdraw**: use `decline-work-request` or `supersede-work-request` from
  `captured`, with the reason and replacement where applicable.
- **Plan**: `propose-ready-plan` on a triaged request, using its current schema.
- **Discussion**: use the delivering PR; these verbs provide no comment operation.

Each write needs a UUID `idempotency_key`; changes to an existing request need
`base_version` from a fresh card. Check the live verb schema before writing.
`report-problem` and `propose-ready-plan` are connector operations, not additions
to the app's pinned MCP operation list.

Finish authorized work that fits the session. Follow the current CARR product
priority policy before filing follow-ups; a new prerequisite names the product
task it blocks. Keep client and production details out of this public repo.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Call `report-problem` through the CARR connector.

## When a skill says "fetch the relevant ticket"

Call `work-request-card` with its `WR-` ref.

## Wayfinding operations

`/wayfinder` must use record-layer relationships and lifecycle operations only
where the live schema supports them. This configuration does not declare map,
child, dependency, claim, or resolve verbs. If an operation is unavailable,
report that specific gap; do not invent fields, use GitHub Issues as a second
tracker, or write `.scratch/` records.
