# System design

Estimated implementation is 60 minutes plus full-suite and hosted CI time. First result confirmed the missing owner predicate on app main 344a2299c0c2a311d1d1d5ef6589d1bef2a75bfb. Producer fixture provenance pins app parser 350951eb88b486e2d636fe4e22ea2fdf21156794 and carr-relationship-network.v1. No producer changes are needed.

The existing page owns one validated snapshot and URL filters. The typed island owns selector rendering and disposal. Owner selections serialize one-element JSON arrays. Null means owner not recorded; raw nonblank strings retain whitespace and match exactly. Empty selection means all. This separates missing owners from a recorded owner named Owner not recorded.

One local scan creates owner options, then the existing filter prunes complete paths. There are no per-node reads or N+1 requests. At 10x data, DOM graph and directory rendering break first; the existing graph cap remains. No new storage, queue, write, external operation, retry, rate limit or idempotency key is needed. The existing refresh transport owns read deadlines and refresh cadence. The page serves a still-valid snapshot after transient refresh failure, conceals expired data and rejects malformed data. Owner options invalidate only with an accepted snapshot. Disposal retires the selector and ignores late completions.

The proof uses one total deadline and the shared release transport, refuses unverifiable release ancestry, and must drain acquired pages before disconnecting. No production proof is claimed from fixtures.

The chart models page, selector and proof independently. TLC from-chart checked TypeOK, DisposedControl and LiveControl with no violations, and reproduced the input chart. It abstracts payload validation, focus and time into event labels; browser tests must verify those details.

## Transition tests

| Transition | Named test |
| --- | --- |
| Hidden to Ready, snapshot arrives | owner restore select conjunction reset refresh disappearance and zero business reads |
| Ready to Hidden, snapshot expires | owner removes focus, conceals expiry and retires control on disposal |
| Ready to Ready, refresh succeeds | owner restore select conjunction reset refresh disappearance and zero business reads |
| Ready to Closed, dispose | owner removes focus, conceals expiry and retires control on disposal |
| Hidden to Closed, dispose | owner disposal during initial load ignores late completion |
| All to Selected, choose owner | owner restore select conjunction reset refresh disappearance and zero business reads |
| Selected to Selected, choose owner | owner restore select conjunction reset refresh disappearance and zero business reads |
| Selected to All, reset | owner restore select conjunction reset refresh disappearance and zero business reads |
| Selected to All, owner disappears | owner restore select conjunction reset refresh disappearance and zero business reads |
| All to Retired, dispose | owner disposal during initial load ignores late completion |
| Selected to Retired, dispose | owner removes focus, conceals expiry and retires control on disposal |
| Unchecked to Checking, begin proof | proof equal |
| Checking to Passed, exact observations | proof equal |
| Checking to Failed, wrong observations | proof failure |
| Checking to Insufficient, deadline or unavailable | proof deadline cleans stalled evaluation |

DisposedControl is exercised by both disposal tests. LiveControl is exercised by selecting owners and refreshing in the restore test. No-comments pass removed copied phase narration from new code. Model the Domain chose distinct serialized null and raw-string values. Type System Discipline kept the island inputs typed and avoided casts.
