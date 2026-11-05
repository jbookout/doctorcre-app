# Board proposal badges

Card: WR586.S5.J10

## System design

The board owns deal navigation and badge hosts. A single typed badge controller owns a page-lifetime map of server counts, feed state and session generation. CARR owns pending counts and pagination. The synthetic `board-tour-proposals.v1` contract is a delivery dependency, not a claim of deployed support.

One board load reads one feed, with sequential cursor pages and no deal-level fan-out. At 10x deals, requests grow with pages rather than rows. Pages contain at most 100 counts; reads stop after 100 pages or a repeated cursor. Partial pages never publish zero. Missing deals mean zero only after the complete feed succeeds. Invalid or unavailable feeds show a quiet unavailable label. Normal deal navigation remains available.

Counts stay in memory only. Board paints and filters reuse them. A board reload or confirmed proposal readback invalidates the complete feed. Concurrent refreshes coalesce, with one trailing refresh if invalidated during a read. Sign-out clears counts and rejects late responses. There are no background polls or automatic failure retries. Each page has a ten-second deadline. The server owns additional rate limits.

Reads are idempotent. No writes occur in the badge controller. Proposal decisions remain owned by the workspace card. Credentials use the existing session transport. No counts persist across sessions.

Workspace integration is pinned to holder `wr586-s5-j5` at `ac9b17db6a970497b4d2863423e6ac292ef71a59`. Its host is `workspace-tour-proposals`. Its confirmed `onPending` readback removes/adds `data-tour-proposal-badge` markers. The controller observes that existing callback signal and rereads the board feed, including when the last proposal disappears. It does not infer counts from those markers. Opening a badge opens the normal workspace and focuses that proposal host once mounted. Until the holder lands, ordinary workspace opening still works. Tests supply this holder boundary synthetically.

## Design choices

A controller per row would duplicate requests and session state. One controller with React portals into board-owned hosts shares a single feed and keeps pipeline changes additive. Counts are parsed from unknown at the network boundary, then represented by a map and a discriminated state union (Model the Domain and Type System Discipline).

## Throughput checkpoint

- Blocking first steps. Read board, transport and holder contracts; write this note and failing browser tests.
- Independent workstreams. n/a: one worker owns the coupled controller and integration.
- Shared mutable state. One controller owns counts; the board owns only disposable hosts.
- Smallest safe decomposition. One typed module, one fixture, one browser suite and additive pipeline/bundle hooks.

## Statechart

The requested statechart skill is absent; this table is the test source.

| State | Event | Next state / observable behavior |
| --- | --- | --- |
| idle | board load | loading; one feed, no row requests |
| loading | complete valid feed | pending(n) for positive server counts; zero for others |
| loading | failed or invalid page | unavailable for all rows; navigation stays usable |
| pending(n) | activation | open existing workspace proposal card; preserve count |
| pending(n), zero, unavailable | board reload or confirmed keep/use readback | refreshing; discard stale counts |
| refreshing | complete valid feed | pending(n) or zero from new server counts |
| refreshing | failure | unavailable, never fabricated zero |
| any | sign-out | idle; clear UI and discard late responses |
| loading, refreshing | concurrent invalidation | finish then run one trailing refresh |

The browser matrix uses 390px/1440px and light/dark for pending, zero, failure, pagination, keyboard, sign-out, confirmed keep/use refresh and ordinary navigation. Additional tests cover invalid pages, cursor loops and late sign-out responses.

## Verification

The failing-before browser test timed out waiting for the absent pending badge. The completed suite passes 48 matrix cases plus its parent test, with no skipped cases. Keep/use tests use a synthetic holder card and confirmed decision/readback responses. They prove the badge's integration boundary, not the unmerged holder implementation or deployed CARR service. Sign-out uses the actual account control against synthetic local authentication responses; the late-response case drives the session invalidation event directly.

Required checks passed: `node scripts/prepare-offline-tour.mjs`, `npm run check`, and `node scripts/check-typed-surfaces.mjs origin/main`. The typed checker requires its base argument.

Clean execution used a new HOME, restricted PATH, freshly installed locked dependencies with an empty npm cache, and a freshly downloaded Playwright Chromium. The exact test command, run from the temporary clone, was:

```sh
env -i HOME=/tmp/wr586-s5-j10.pSqqXX/clean-home PATH=/tmp/wr586-s5-j10.pSqqXX/clean-bin:/usr/bin:/bin node --test test/deal-proposal-badge-browser.test.mjs
```

Result: 49 passed, 0 failed, 0 skipped (48 cases plus parent). No production calls, deployment, PR, or merge. The holder and feed remain delivery dependencies. Statechart fallback was used because the named skill path was absent. No independent review was run by this worker.
