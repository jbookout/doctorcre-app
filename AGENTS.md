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
- Use an isolated branch or worktree, relevant local checks, a pull request,
  green hosted CI, merge, and delivery verification.
- Durable application knowledge belongs in the future DoctorCRE project record
  store. Do not turn Markdown into a substitute database. This file and the
  README are lean source-controlled boot documentation.

## Current state

The initial product source was isolated from `carr-system` commit
`b1f393190a4633c37219099ae883f09f3135f58d`. The app remains a no-build static
module. `DealRoomClient` is its CARR seam, with live HTTP/MCP and in-memory
fixture adapters. The repository contains synthetic fixtures only; real deal
records remain in CARR. Source isolation did not change CARR runtime or
deployment.
