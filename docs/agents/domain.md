# Domain Docs

How the engineering skills consume DoctorCRE's domain documentation.

## Before exploring, read these

- [AGENTS.md](../../AGENTS.md) and [README.md](../../README.md) for repository
  ownership and source-controlled boot guidance.
- The relevant versioned contracts in `contracts/` and their source pins.
- For CARR business terms, use the CARR connector's `search-doctrine`, then
  `read-doctrine`; `doctrine-index` lists documents. Search the CARR decision
  log by the behavior a decision governs, rather than an identifier alone.

## File structure

Layout: **single-context**. Do not create `GLOSSARY.md`, `GLOSSARY-MAP.md`,
`docs/adr/`, or `.scratch/` domain records. [AGENTS.md](../../AGENTS.md) reserves
application knowledge for the future DoctorCRE project record store; business
doctrine remains in CARR. These agent configuration files are consumer pointers,
not a replacement knowledge store.

The app-only record store is described as future, with no writer established
here. Continue source exploration from the boot documents and contracts. When
`/domain-modeling` resolves an app-only term or decision, report the missing
record destination in the delivering PR instead of creating Markdown records
or treating CARR as the owner of app-only knowledge. When a task requires live
CARR doctrine, retrieve it; if unavailable, name the missing source and do not
invent its contents.

## Use the glossary's vocabulary

Use terms as defined in the applicable doctrine and contracts; do not drift to
synonyms. An absent definition is a gap for `/domain-modeling`, subject to the
record destinations above.

## Flag ADR conflicts

Surface conflicts with recorded decisions and the repository placement contract,
with the decision's plain-language subject and a reason to reopen it.
