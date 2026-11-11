# Vendor meetings

Suggested and Research are server-classified vendor-meetings.v1 pages. Each row owns an exact contact (nullable for Research), company, sourced office, reason, missing criteria and possible calendar meetings. Unknown channels do not change membership.

## System design

The typed island owns selected tab, submitted search and one bounded five-person page. The directory owns the existing vendor dialog and session lifetime. An injected read adapter uses the existing authenticated MCP transport with a 15-second deadline. No cache, background polling, queue, write, optimistic update or new storage. Tab and submitted-query changes clear pagination and synchronously retire the old read. Disposal and session invalidation retire all reads and erase rows. Failed reads display retry without stale results. Calendar unavailability preserves vendor results; partial-source notes remain visible.

Two designs considered: add meeting modes to the directory URL/list state, or isolate the bounded page in a typed island. The island keeps meeting cursors separate from company directory cursors and reuses record detail navigation. One request per submit/tab/page/retry, no N+1, fan-out or automatic retry. At ten times today's usage CARR query/calendar reads become the first limit; the app still requests five people per page. Server keyset consistency is live and pages can change after record changes. Circuit breaker is one failed read with manual retry. Idempotency is n/a for reads.

## Phone directory disclosure

A native details element starts collapsed at phone widths and open on desktop. On phones its closed summary shares the search row, preserving three complete vendor rows at 390 pixels. Opening it gives the meeting panel the full width. Closing it retains the selected tab, query and page. The native element owns disclosure state and keyboard interaction; React still owns the unchanged read lifecycle. No added requests, storage or transport changes.

A separate meeting route was considered. The native disclosure keeps the existing directory context and avoids a second navigation state. `vendor-meetings-disclosure.mmd` models its independent visibility. Initial closed entry is covered by all phone vendor-layout cases. Open, close and keyboard reopen are covered by `phone disclosure restores directory and retains meeting view across close and reopen`. Desktop entry is covered by the existing Suggested and fit tests. The chart abstracts native browser visibility and starts at phone entry; desktop starts expanded.

## Transition tests

- Initial loading to ready: Suggested retains exact named people with unknown channels and unavailable calendar.
- Loading to empty and failure; failure to retry: empty, failure and retry remain distinct.
- Ready to next page; any active read state to changed tab/query: pagination is query-bound and keyboard tabs retire late responses.
- Obsolete success/failure to unchanged current state: pagination is query-bound and keyboard tabs retire late responses.
- Every active state to cleared on session retirement: session retirement erases results and ignores pending responses.

The chart abstracts request identity into current versus obsolete responses. Actual deferred-response browser tests check that distinction. Calendar state is read-only response data, independent of the page request state.

## Model verification

Copy `vendor-meetings.mmd` to a scratch folder, then run `TLA2TOOLS=/tmp/wr591-tla2tools.jar node /Users/booko/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/statechart/scripts/statechart.mjs from-chart vendor-meetings.mmd`. TLC checks the three retirement invariants. The model abstracts calendar response data and actual query strings; browser tests exercise the concrete payload and request identities.

## Production proof

The runner opens Vendors once and changes theme through the shell control before resizing. Each tab change captures a fresh authorized response. This avoids four complete module downloads exhausting production asset rate limits. The regression `proof covers both themes and widths without reloading into the asset rate limit` serves HTTP 429 for the fourth directory module load and requires all eight observations from one document. The runner asserts the actual theme and reports counts without person identifiers.

Run `node scripts/prove-vendor-meetings.ts --origin https://app.doctorcre.com --expected-commit <merge-commit> --cdp-url <existing-signed-in-browser> --screenshot-dir /tmp/WR591.S24.J1-shots`. The proof requires a containing app release, captures each authorized app response, and compares people, companies, offices, office sources, contact channels, reasons, missing reasons and possible meetings exactly. It observes Suggested and Research at 1440 and 390 widths in light and dark. A genuine zero count is accepted as zero. A near-miss rendered value fails. An assertion failure on a containing release, including the initial theme check, exits 1. A missing release or session, failed HTTP response, or undecodable response exits 78 even after an earlier successful observation. This read never sends an introduction or changes a record.
