# Interactive conversation answers

Canonical conversation turns may carry sourced tables and bar or line charts. Tables expose keyboard sorting, a row filter, reset and source disclosures. Charts retain the full accessible table and expose values on hover or focus. Comps are proposed negotiation rents. Generic tables use their supplied column labels; the app does not infer confirmed market coverage.

The data shape is a discriminated union of table.v1 and chart.v1. Numeric cells retain a record pointer or versioned fact pointer. Source IDs are opaque disclosures, never fabricated URLs. Pointer syntax is checked; this reader cannot independently verify record existence. Unknown or malformed blocks leave prose visible with “Interactive answer unavailable”.

Architecture alternatives considered: expand the string renderer with delegated DOM controls, or mount a typed React island in each canonical turn. The island keeps validation, table interaction and chart rendering behind one mount interface. The conversation controller retains fetch, pagination and ordering ownership. No second conversation store or turn writer is introduced.

## System design

- Capacity/scaling: two partners or twenty readers use bounded local work, eight blocks, 200 rows and twenty columns per table, 128KiB encoded. DOM cost breaks first. Parser tests exercise the maximum and refuse excess.
- Load spread/cache: fingerprint each turn snapshot. Unchanged polling skips parsing and rendering. Sort/filter state is keyed by conversation/message/block content. Changed blocks reset their own controls. Removed turns and switched conversations dispose roots. Browser tests exercise refresh, replacement and removal.
- Availability/consistency: validate the complete snapshot before rendering charts or tables. Invalid input retains prose. The existing controller continues to own read deadlines, refusal states, pagination and late-response cancellation. Existing conversation and refresh suites cover those paths.
- Storage/N+1: no storage or per-cell reads. Rendering never fetches sources. The module imports only React and its pure model.
- Async/circuit breakers/rate limits: n/a for new external work. The reader adds no requests, polling, queues or fan-out. Existing conversation read deadlines and failure handling remain in place.
- Idempotency: no writes or sends. Each host owns one root. Repeated identical updates are skipped. Disposal unmounts and deletes its entry. Browser tests exercise repeated refresh without duplicate tables or lost controls.

The visible transitions are in [the statechart](../verification/interactive-answers.mmd). This is a design chart, not a formally checked TLA+ model.

Throughput checkpoint: contract and chart first; parser and UI have one owner because turn lifecycle couples them; no fan-out or shared mutable writes; one reader PR is the smallest verifiable unit. The quick-switcher PR holds bundle registration, so this branch is built and pushed while its PR waits.

The pinned schema is copied byte-for-byte from DoctorCRE/carr-system at da7e942d8517bca780bb5591b946d289ae11c0c3, the existing producer pin, which includes PR 2804 (3eee0e7c6eaf89d15dcf3e0db56a314b62176b19). This avoids regressing newer contract entries to an older producer revision. The interface directory is composed by scripts/carr-interface.mjs.

The source pattern supplied by the planning report is pingdotgg/t3code apps/web/src/components/chat/HtmlRenderFrame.tsx at 86b7dc6bfa12123abef683811c852ec320537690. The desired stable inline result is implemented with sourced blocks, not arbitrary HTML. That upstream implementation was not fetched by this builder.
