# Share into a deal from the phone

The installed PWA receives PDF and photo files at `POST /share-to-deal`.
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

Uploads run sequentially. An interrupted action reads its known reservation or replays begin with its
original key before retrying. Each file has at most three attempts. Explicit refusals stop
attempts. The visible page permits at most one reconciliation action per minute,
which also exceeds the transient retry backoff. Confirmed files are skipped.
One canonical document-list refresh follows a batch. Success requires the exact
attachment identifier, hash and selected deal. An absent confirmation retains bytes.
RPC deadlines are 10 seconds; upload HTTP calls have a 30-second deadline.
Navigation aborts the active lifetime and ignores late callbacks.

## P6 contract pin

The upload contract is pinned to CARR P6b revision
`7d3d1407678fef98eab3fe8ac7ea513f3d5b9779` and P6a revision
`6fbb43493922577b4878f6db48c37f3974b3c7fe` in
`contracts/carr-interface.v1/deal_document_upload.json`.
The original schema is `mcp-server/contracts/deal-document-upload.v1.json`.

Begin sends filename, declared_mime and the draft UUID as action_id.
The reservation binds the deal. Commit sends only upload_id and its retained key.
A lost begin response replays begin with identical metadata and key.
Known reservations reconcile through the authenticated HTTP read endpoint.
That endpoint can verify uncertain stored bytes and return staged.
Bytes use POST `/api/v1/deal-documents/uploads/{upload_id}/bytes`.
Cancellation uses the authenticated `/cancel` endpoint with Idempotency-Key,
so CARR confirms deletion of staged bytes before refunding quota.
All HTTP writes verify the current session and send x-carr-csrf.

Receipts use reserved, receiving, staged, retryable_unknown, rejected,
cancelled, expired and filed. Each non-success state has partner-facing copy.
Only staged bytes proceed to commit. The selected-deal canonical list must
contain the filed attachment id and matching content_hash before local removal.
Office formats are refused in the picker, receiver and both manifests.
The fixture adapter follows these wire shapes and states using synthetic data.

The PR remains held until P6a/P6b merge and wr617-s3-j6 push opt-in integration.
This change does not modify public-shell/sw.js. No production calls were used.

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

The P6 receipt model is [Upload.tla](../verification/Upload.tla), with
[configuration](../verification/Upload.cfg), [view](../verification/share-upload-view.mjs),
[chart](../verification/share-upload.mmd) and
[report](../verification/share-upload-model-report.md).
TLC explored 10 states and 29 steps. All three invariants and the deadlock check
passed. The chart hides unchanged receipt checks. The model covers one file and
leaves out authorization, streams, quota and concurrent tabs. The earlier Share
model covers actor binding, selection and local expiration separately.
