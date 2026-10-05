# AGENTS.md

## Purpose

This repository is the independently built and deployed DoctorCRE human
application for CARR. The governing architecture decision is
`1ceee300-7627-426f-b729-ab339d6984fc`; the initial placement contract is CARR
doctrine section `3bb51d3e-2661-4ea2-a585-053540545b5d`.

## Boundaries

- CARR business records, domain rules, doctrine, authorization, migrations,
  runtime control, assurance, and CARR releases remain in
  `jbookout/carr-system`.
- This application uses authenticated, versioned CARR API or MCP contracts. It
  never reads or writes the CARR database directly.
- This repository owns DoctorCRE UI and interaction logic, app routing and
  presentation, its independent build/deploy lifecycle, project knowledge
  about DoctorCRE, and app-only state.
- It must have no runtime dependency on `jbookout/software-factory`.
- Do not copy CARR's control plane or assurance fabric here merely to avoid an
  interface.

## Working rules

- Keep the implementation as simple as the product permits. Add architecture
  only for a demonstrated requirement.
- Never commit credentials, production data, client data, or generated secret
  material. This repository is public.
- Treat contracts, schemas, migrations, adapters, entry points, and tests as
  first-class change surfaces.
- Bind cross-repository changes to exact revisions and versioned contracts.
- Publish deployment input as the deterministic static artifact produced by
  `npm run build`; consumers pin its source commit and SHA-256 digest.
- Use an isolated branch or worktree, relevant local checks, a pull request,
  green hosted CI, merge, and delivery verification.
- Durable application knowledge belongs in the future DoctorCRE project record
  store. Do not turn Markdown into a substitute database. This file and the
  README are lean source-controlled boot documentation.

## Current state

The initial product source was isolated from `carr-system` commit
`b1f393190a4633c37219099ae883f09f3135f58d`. The app remains a no-framework
static module behind a small app-owned edge Worker. `DealRoomClient` is its CARR
seam, with live HTTP/MCP and in-memory fixture adapters. The repository contains
synthetic fixtures only; real deal records remain in CARR. Source isolation did
not change CARR runtime or deployment.

## Review-derived standards

Counts are distinct PR occurrences in the 2026-10-05 review harvest; repeated findings within a PR count once.

- Bind async completions to the actor, record, query and operation that started them; test an obsolete response arriving last with `Promise.withResolvers()` (26 PRs).
- On authorization loss or actor change, invalidate pending reads and conceal all derived records, dialogs, drafts and offline access before repainting (17 PRs).
- Retain the exact payload, base version and idempotency key for unknown writes; expose same-request recovery and separate definite refusal (12 PRs).
- Validate consumed fields before publishing success; keep malformed, partial, unavailable, unknown and verified-empty states distinct (30 PRs).
- Refresh must preserve drafts, stable selections and loaded pagination; recheck edits and operation identity after each await (25 PRs).
- Bound transport and body reads, release refresh locks on failure, and show a reachable retry without promoting stale data to current (24 PRs).
- Exercise the exact contract-pinned producer with producer-shaped fixtures; reject assumed fields, stages, identity joins and undocumented capabilities (28 PRs).
- Check routed pages and assets through the built artifact and Worker, including CARR admission, CSP and Permissions-Policy (10 PRs).
- Restore focus by stable identity after repaint; use a visible, focusable fallback and keep Escape/focus inside the top modal (22 PRs).
- Verify rendered hit targets and legibility at phone widths with the shared shell mounted; check computed reduced-motion behavior (17 PRs).
- Reuse the existing owner of a shared rule and migrate real callers when retiring a flow; remove unreachable paths and test-only substitutes (14 PRs).
- Tests must execute the claimed behavior and await observable completion; derive contract expectations from files and use fixture-owned history and shared clocks/budgets (14 PRs; literal contract-pin assertions fail `npm run check`).
- Choose the required business or viewer time zone explicitly; derive freshness from observation time and test local-day and expiry crossings (6 PRs).
- When replacing a view, inventory its supported source fields and reachable actions and verify each survives at the new destination (7 PRs).
- Review against fetched `origin/main` and require green hosted merge-candidate checks after resolving branch drift (4 PRs).
- Bind proof and publication to the observed source, served artifact and locked tool; revalidate before success and preserve earlier evidence seals (3 PRs).

## Before every PR: design and debt pass

Before opening or updating any pull request, apply both skills to the diff:

1. `codebase-design`: deep modules, real seams, design the interface twice when it matters.
2. `zero-tech-debt`: rework the change from its intended end state; delete dead compatibility paths and duplicated rules.

Both are installed at `~/.agents/skills/` (sources: github.com/mattpocock/skills `skills/engineering/codebase-design`, github.com/jnsahaj/skills `skills/zero-tech-debt`). The PR reviewer checks both, so all two are required.
