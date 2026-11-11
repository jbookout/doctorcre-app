# Vendor client needs

Card: WR591.S27.J4

Selecting a vendor shows the approved deal-owned needs returned by CARR. The app never infers matches from geography, category or vertical.

The producer schema and synthetic recording are pinned from DoctorCRE/carr-system at b1d820087d6d0c260980405581640508da4765cd. Both production and tests use `parseClientNeeds`, which checks that schema and the selected vendor, current approval revision and freshness. The interpreted schema validator works under the app's CSP without runtime code generation.

The existing business view owns vendor selection in its URL. A React island owns the read state and a five-row page. Its host survives activity-only redraws. Selection changes, record failures, closure and session retirement dispose it and cancel pending reads. Refresh clears visible rows before reading; no stale cache is retained. The server owns matching and authorization. Source references are displayed as text because the contract does not promise a navigable URL.

Two designs were considered directly because this worker may not delegate. Putting reads into the business view would spread typed parsing and paging across legacy state. A single mounted island keeps those concerns together behind a mount/dispose interface. Reusing the meeting list would mix two different contracts and was rejected.

At current and tenfold load, one selected vendor costs one bounded read per opening, refresh or page. No per-row request, background loop, queue, write or persistent cache exists. A read has a 15-second deadline and zero automatic retries. Failure opens the unavailable or permission state; an explicit retry is the only recovery. Requests remain serial per panel and abort on disposal. CARR owns storage, indexes and server capacity; the app adds no database access. No write idempotency key applies.

The chart in `vendor-client-needs.mmd` models independently changing session and results. It checks that a retired session never shows approved matches. The finite model leaves out HTTP, wall-clock expiry and database races; runtime parser and browser tests cover those boundaries.

Throughput checkpoint. Contract and statechart are the blocking first steps. Parser and UI are one coupled workstream with one owner. The only shared state is the existing vendor URL and host lifecycle. No fan-out or new orchestration is needed.

Production proof runs `node scripts/prove-vendor-client-needs.ts --origin https://app.doctorcre.com --expected-commit <app-merge-sha> --vendor <existing-vendor-uuid> --cdp-url <signed-in-browser-url>`. Exit 0 requires a containing app release and exact equality of every displayed need, client, deal, applicability, source revision and approval, at 1440 and 390 in both themes. Exit 78 reports insufficient release, session or positive data evidence. The coordinator must also verify that the containing CARR release includes the producer. No production need is created to satisfy proof.

Independent staging taste review and positive production proof are outside this builder's observations. Synthetic screenshots are not independent scores.
