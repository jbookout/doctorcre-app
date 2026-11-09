# File share intake

The model uses `IntakeState` in `src/ui/share-intake-model.ts`. The controller owns session fencing, frozen operations, write identities and receipt/list confirmation. The service worker owns a single volatile file and its ten-minute expiry. The UI owns rendering only.

| Transition | Behavior test |
| --- | --- |
| Receiving → Choosing → Ready → Filing → Filed | receiving choosing ready filing filed requires exact receipt and list readback |
| Receiving → Refused | offline has no preview or writes; one bounded PDF or photo only |
| Choosing → Refused | near-match deal choice refuses before writes |
| Filing → Uncertain → Filing → Filed | lost-reserve reconciles frozen target and reuses write keys; lost-finalize reconciles frozen target and reuses write keys |
| Choosing/Ready → Retired | discard clears unreserved bytes without creating a reservation |
| Uncertain → Filing → Retired | discard after lost reserve reconciles then abandons with stable key |
| Receiving/Choosing/Ready/Filing/Uncertain/Filed/Refused → Retired on session change | session retirement clears receiving/choosing/ready/filing/uncertain/filed/refused and fences later completion (seven behavior tests); sign-out returns no bytes |
| Pending custody → Retired on expiry | expired custody cannot return preview bytes |
| Share POST → Receiving | share POST hands off exact bytes through 303 without shell cache or network POST |
| Second POST → Refused, first unchanged | second share is refused and cannot replace first |
| Invalid/oversize/cross-origin POST → Refused | cross-origin visibly refuses without caching; wrong type visibly refuses without caching; oversize visibly refuses without caching |
| Unknown POST → network | unknown POST remains network-only |

The chart is a behavior inventory. It does not prove server authorization, phone OS registration or browser service-worker lifetime guarantees. Receipt identity and exact deal matching are checked by the contract parser and behavior tests, rather than inferred from a label in the chart.

## System design

The lightest supported path is the OS Web Share Target POST, existing root worker, app-owned intake page and authenticated CARR browser intake. Both manifest sources register the same one-file target. The build serves the root manifest. CARR producer is pinned to `926602dead49619842aa4e617dae08d96fed40c2`. The unmodified contract SHA-256 is `1b3ab41c88d1fc094ef443e7e8d1af87f5690e63145f9ee4efaa40ec41855b4a`; the response fixture is copied from that commit.

A bounded multipart stream limits the entire request before parsing, with 64 KiB for multipart framing. A fixed-capacity byte buffer prevents tiny stream chunks from growing an unbounded list of allocations. Only one file and no additional form fields are admitted. Each file is at most 25 MiB. At ten times usage, the same one-share cap prevents memory growth; a second share is visibly refused. The worker holds the file and server CSRF binding only in volatile memory. It never persists auth, file bytes, API replies or POSTs. There is no IndexedDB handoff because the producer exposes no non-secret session identity. Worker termination fails closed and requires a new share. This is a deliberate availability limitation and a deviation from the draft's preferred durable handoff.

The file expires after ten minutes. Success and discard clear worker custody. The existing sign-out message clears it. The page clears its preview on session retirement, storage epoch change and expiry. Requests compare the verified session before and after each response. There is no background queue, polling or automatic retry. Every external failure stops the chain and offers manual reconciliation. The maximum list readback is ten pages of fifty documents; there is no per-deal fan-out. The board is one bounded read with local choices; filing re-reads authority and refuses an exact ID no longer present. This selector covers available board rows, not a claim of exhaustive deal access.

A frozen operation has one key for reserve, finalize and abandon. The worker retains them across intake navigation while it lives. Lost reserve replies replay the exact arguments/key. Known reservations reconcile through receipt before upload/finalize. A finalized receipt must parse and match the file's deal, name, MIME, size and SHA-256, then appear in list-deal-documents before the UI says Filed. No object key is constructed. A lost finalize reply cannot re-upload bytes or change the deal. Discard before reservation just clears custody. Discard after an uncertain reserve first recovers that reservation, then abandons it. A finalized receipt is reconciled rather than represented as discarded.

## Design and debt pass

Codebase-design keeps the contract parser and the stateful filing controller behind small interfaces used by real UI and tests. Two custody designs were considered. Durable IndexedDB has no supported session binding; volatile worker custody fails closed without persisting credentials. Zero-tech-debt keeps one filing path and existing worker/cache policy. It introduces no generic upload queue, proxy or fabricated attachment identity. The added code replaces the absent share-to-document path; there was no obsolete implementation to delete.


## Throughput checkpoint

- Blocking first steps. Pin the producer contract, inspect both manifests, and reproduce missing intake before implementation.
- Independent workstreams. Contract parsing, worker custody, UI and proof have distinct files; one worker owns their integration under the no-subagent instruction.
- Shared mutable state. One pending share stays in the root worker; operation writes freeze the exact target before reserve. No cache or persistent session store is shared.
- Smallest safe decomposition. One app PR owns this vertical slice. No CARR, factory, link-filing or production-write work is included.

## Verification limits

The statechart tool generated a TLA/CFG skeleton but exited because it could not find TLC in its configured environment. The generated skeleton is retained outside the repository under `/tmp/j177-model-scaffold`, rather than checked in as a verified model. No TLC invariant pass or PNG model rendering is claimed. The transition table is backed by executed behavior tests and an installed-worker Chromium flow with a real multipart navigation, not a phone OS observation.

The app edge serves the intake HTML as an explicit public utility shell. It contains no private data. This avoids requiring an unrelated producer page gate before session verification. The root service-worker cache allowlist is unchanged; the intake page, POST and all private reads bypass it.
