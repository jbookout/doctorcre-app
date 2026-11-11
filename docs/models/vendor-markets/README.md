# Vendor market browsing

The app pins `vendor-markets.v1` version 1.0.0 to producer PR 3183 at `3d49c4b8d490828183f24d888ab671ad1e7ae8dc`. The contract and recorded synthetic fixture are included. No territory parsing determines membership.

## System design

One React island owns view and canonical selection in the URL. The parser refuses inconsistent identities, counts and references. CARR owns aliases, reviewed membership, Regional links and office declarations. Category preserves the existing directory. Suggested and Research retain their own lifecycle.

Two interfaces were considered. Filtering the category directory would mix territory with reviewed membership. A separate snapshot reader keeps those rules at their source and exposes one load interface.

One request has a 15-second deadline. Failure clears results and offers explicit refresh. There is no automatic retry or stale fallback. Cleanup aborts reads and fences late completions. Session invalidation unmounts the island. There is no cache, queue, write, database access, N+1 request, or fan-out. Selection is app-only URL state. Category is the default and is omitted from the URL. Mounting does not write URL state. User selections and producer alias resolution use replaceState; returning to Category removes both vendorView and vendorMarket while preserving unrelated URL state. The existing MCP transport supplies bounded reads. At the producer caps of 100 markets and 5000 memberships, rendering a dense selected market is the first likely limit at 10x. No latency claim is made. No writes require idempotency.

## Statechart

The Mermaid sketch preceded implementation. The generated TLA+ model adds actual session and active-read guards. The initial unguarded sketch allowed late completions after an empty read. The checked model forbids them. `TypeOK`, `EmptySelected`, and `RetiredClears` hold over 14 distinct states. The retired session stutters without re-enabling reads or restoring selection, so TLC also checks cleanly with deadlock detection enabled. Identity, network timing, URL serialization and DOM layout are abstracted and covered by browser tests.

To regenerate, copy this folder to scratch and run the statechart skill with `from-spec Markets.tla`. The first run writes a mapping file. Repeat the command to check the model.

| Transition | Browser test |
| --- | --- |
| Category to Market, read, select market, select Regional, refresh, reload, empty, return to Category | market membership, multi-market, Regional, refresh and empty (four size/theme cases) |
| Default Category mount and reload; Market to Category URL replacement; canonical Market deep link | Category settles and reloads at exactly /vendors; Market selection then Category replaces URL state and reloads at exactly /vendors; canonical Market deep link restores Market and its selection |
| Alias resolution, unavailable, retry, retire ready session | producer resolves aliases; unavailable retries; session retirement erases answers |
| Retire late success and failure, retire pending session | category switch and session retirement fence late success and failure |

## Production proof

Run `scripts/prove-vendor-markets.ts` with `--origin`, `--expected-commit`, and `--cdp-url` after the app and producer releases contain their merge commits. The proof compares exact membership UUIDs, counts, people, other markets, office evidence, service coverage and Regional references at 390 and 1440 in light and dark. Exit 0 proves a containing release. Exit 1 is an assertion failure. Exit 78 means insufficient evidence, including an empty registry or missing reviewed multi-market and Regional examples. Fixture tests exercise pass and near-miss failure through the same parser and CLI. Production population is outside this builder job.
