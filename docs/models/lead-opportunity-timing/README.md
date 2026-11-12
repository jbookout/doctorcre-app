# Lead opportunity timing

The typed component accepts only the producer's nested timing projection. It owns validation, escaping and date presentation. It never reads update or stage dates. The existing workspace owns selection, response epochs, refresh and retirement. The client validator accepts the component parser at that boundary, keeping generated browser imports out of source-only client tests.

The alternative was one React root per card. Pure HTML fits the existing atomic board render and native progressive details without another mutable lifecycle. There are no added reads, caches, queues, storage, retries or writes. Rendering grows with returned leads and events. At ten times the snapshot size, DOM rendering is the first cost. A malformed timing projection refuses the read. An absent older-producer projection displays Added unavailable and opportunity timing unknown.

The contract document is copied byte-for-byte from the revision in source.json. Synthetic fixtures pass through the real workspace/detail validators and the same timing parser used by production. The pin test verifies the copied contract digest.

## Transition coverage

| Chart transition | Named test |
| --- | --- |
| Board to Detail | Opportunity dates proof walks desktop and phone themes with keyboard paths |
| Detail to Detail on revision | Selected detail replaces revisions, withdraws and restores support, closes and retires |
| Detail to Unknown | Selected detail replaces revisions, withdraws and restores support, closes and retires |
| Unknown to Detail | Selected detail replaces revisions, withdraws and restores support, closes and retires |
| Detail or Unknown to Board | Opportunity dates proof walks desktop and phone themes with keyboard paths |
| Board, Detail or Unknown to Retired | Retirement clears each timing view and fences late detail responses |
| Retired to Board | Retirement clears each timing view and fences late detail responses |

LeadTiming.tla models the visible projection atomically, with three bounded revisions. TLC checks TypeOK, NoUnknownSource, NoRetiredSource and NoOldRevision. It leaves out HTTP transport, DOM layout, calendar arithmetic and the workspace epoch implementation. Browser tests exercise those paths. Run TLC with Java 21 and tla2tools.jar. The statechart skill's from-chart command also round-trips selection.mmd unchanged.

## Production proof

Run scripts/prove-lead-opportunity-timing.ts with --origin, --expected-commit, --producer-origin, --producer-commit and --cdp-url for a signed-in browser. Supply --producer-cwd when CARR Git history is in another checkout. Both release identities must contain their expected merge commits. The contract remains pinned to the approved source revision, while the release check uses the eventual producer merge commit so squash delivery works. The proof exits 78 when containment or existing supported/unknown examples are unavailable. It compares each date, basis, source identity, revision and reference exactly at 1440 and 390 in both themes. An assertion failure on containing releases exits 1. The CLI writes no business records.

The proof uses a separate board read as the expected projection. It cannot rederive CARR's database classification or establish correction history from a current-only event. The producer proof owns canonical SQL comparison. The consumer fixture explicitly replaces a revision, withdraws support and restores it.
