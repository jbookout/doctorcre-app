# Share into a deal from the phone

The installed PWA receives PDF, Office and photo files at `POST /share-to-deal`.
Safari and iPhone users use **Upload documents** in the deal workspace.
The existing `/share` client-report route retains its meaning.

`IncomingDealShare` owns one explicit pending draft in IndexedDB. It carries
original blobs, SHA-256 hashes, actor binding, deal selection, stable per-file
reserve/commit/cancel keys and receipts. It admits three files and 25 MiB total.
It expires after one day. Shared CacheStorage contains no draft bytes.
The receiver caps the multipart stream before parsing it and checks file magic.
CARR must perform its authoritative format validation before filing.

Sign-in preserves an unbound draft. Logout, revocation and actor changes purge
private drafts, including browsers without a service-worker controller.
The receiver's redirect contains an opaque draft UUID. The GET page uses the
existing `/deals` authentication gate and retains that URL across login.
The server fallback does not read or log the multipart body.

No upload starts on login, resume or reconnect. The user selects a visible deal
and presses **File documents**. A workspace file-picker entry carries that deal
selection. Filenames never select a deal. Deal changes reconcile and cancel old
reservations before discarding their action keys; original bytes remain.

Uploads run sequentially. An interrupted action reads its original reservation
before retrying. Each file has at most three attempts. Explicit refusals stop
attempts. The visible page permits at most one reconciliation action per minute,
which also exceeds the transient retry backoff. Confirmed files are skipped.
One canonical document-list refresh follows a batch. Success requires the exact
attachment identifier, hash and selected deal. An absent confirmation retains bytes.
RPC deadlines are 10 seconds; byte uploads have a 30-second deadline.
Navigation aborts the active lifetime and ignores late callbacks.

## Synthetic contract pin

`contracts/carr-interface.v1/deal_document_upload.json` is an explicitly synthetic
contract, pending P6a/P6b. `js/fixture-client.js` implements the fake. Its reservation
is keyed by the original begin action UUID, with reserved, uploaded, committed and
cancelled states. The fake verifies byte count and SHA-256 and makes commit idempotent.
The synthetic fixture is in memory and is not a durable server simulation.

The planned byte route is
`PUT /api/v1/deal-document-uploads/:upload_id/bytes`. The app forwards it through
its existing authenticated CARR binding. The app has no R2 or database access.
The synthetic receipt must be replaced by the exact merged producer revision and
schemas before production activation. No live CARR calls were used for this build.

The existing board contract returns the visible deal snapshot. The picker displays
25 at a time. The Documents panel uses the existing cursor contract with 25 rows.
Batch confirmation follows canonical cursors in pages of 100, up to twenty pages
per action. A missing attachment or repeated cursor retains an unconfirmed result.

## Verification

Run `node scripts/prepare-offline-tour.mjs`, then the three feature test files with
Node's test runner. Browser tests use synthetic fixtures in Chromium. They verify
receipt, reload preservation, narrow screens, file selection, safe filename text,
quota recovery, cancellation, expiry, revocation, offline reconnect, 250-deal paging
and an axe accessibility scan.
The fixture server lacks the production Worker's `/sw.js` and `/offline.html`
aliases. The installed-receipt test adds those aliases only to its temporary artifact.
The first named PDF test was observed failing before the implementation existed.

The model is [share-to-deal.tla](../verification/share-to-deal.tla), its configuration
is [share-to-deal.cfg](../verification/share-to-deal.cfg), and its chart is
[share-to-deal.mmd](../verification/share-to-deal.mmd). TLC explored 29 states and
70 steps. All four invariants and the deadlock check passed. The chart merges
selected-deal identities and hides terminal stutters. The model leaves out byte
streams, quota implementation, clocks, network scheduling and multiple browser tabs.

Reproduce with the installed pstack statechart command, passing the TLA file,
`--config docs/verification/share-to-deal.cfg`,
`--view docs/verification/share-to-deal-view.mjs`, and a fresh `--out` directory.

Native iOS share-sheet receipt, real installed Android receipt, WebKit, live login,
production persistence
remain unverified. The source build is intentionally held for the overlapping app
changes and final CARR contracts.
