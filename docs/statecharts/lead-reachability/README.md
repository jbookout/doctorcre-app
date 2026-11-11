# Lead views

The existing workspace owns the snapshot, filters, selected identity and session epoch.
`visibleLeads` supplies both the board and `marketCounts`. Reachability is another
filter in that shared path. CARR owns classification. The typed parser and copy
formatter accept the pinned projection without deriving qualification from contact
fields or stage.

A separate board per view was rejected because it would duplicate membership,
selection and map state. The shared filter preserves the existing map shell and
camera. An absent projection remains in Research with an explicit Unknown label.
All leads remains the default. The existing stage filter exposes archived records;
existing suppressed and converted records retain their lifecycle exclusions.

## System design

The browser stores one current actor-scoped board in memory. Reads reuse the
existing authenticated client and its deadline. No new endpoint, storage, cache,
queue, write, send, retry loop or detail-per-lead query is introduced. Refresh
replaces the snapshot atomically after parsing. The existing epoch rejects late
responses after retirement. A compatible refresh preserves selection and the
existing map instance. A returned row excluded by a filter closes its detail and clears selection. A missing row keeps the existing unavailable-detail recovery path while selection is cleared.

Counts and membership are linear in the returned board; rendering and existing
repeated stage counts dominate at ten times the current load. The existing board
read and payload bounds remain the capacity limit. No server fan-out is added.
Failed reads retain a visibly stale snapshot; authorization refusal removes it.
An invalid new projection is refused and the previous snapshot is labelled stale.
The existing manual retry and visibility refresh own recovery and request pacing.
Idempotency and write circuit breakers do not apply to this read-only addition.

The production proof reuses the shared browser lifetime and release reader. It
requires both app and producer containing releases before opening the surface.
It uses one total deadline and exact equality for membership, counts and reasons.
An all-unknown cohort cannot prove positive reachable behavior and exits 78.

## Transition coverage

`Views.tla` abstracts two lead identities and two possible producer classifications.
`Choose`, `Filter`, `Select`, `Refresh` and `Retire` correspond to the workspace
filter handlers, `readDetail`, `refresh` and `suspendPrivateView`. Snapshot
selection is intersected with visible membership in `render`. Retirement clears
the snapshot and selection. The model omits timestamps, rendering, network timing
and producer classification logic. Concrete parser and browser tests cover those
consumer responsibilities. The chart's stale state retains the last snapshot;
its refused state has no private membership.

| Transition | Named test |
|---|---|
| Loading to All; choose Reachable, Research or All | views, keyboard selection, refresh, source change and retirement at both widths and themes |
| Compose owner, market, specialty and stage | view and composed filters keep exact map and unlocated membership |
| Open exact lead by keyboard and return | views, keyboard selection, refresh, source change and retirement at both widths and themes |
| Compatible refresh retains selection and map | views, keyboard selection, refresh, source change and retirement at both widths and themes |
| Source change excludes selection; Research shows unknown | views, keyboard selection, refresh, source change and retirement at both widths and themes |
| Failed refresh retains stale membership | views, keyboard selection, refresh, source change and retirement at both widths and themes |
| Invalid source is refused; authorization removes membership | views, keyboard selection, refresh, source change and retirement at both widths and themes |
| Session retirement clears private membership | views, keyboard selection, refresh, source change and retirement at both widths and themes |
| Next signed-in mount starts All | views, keyboard selection, refresh, source change and retirement at both widths and themes |

Run the model from this directory with Java 21 and tla2tools 1.8.0.

```sh
/opt/homebrew/opt/openjdk@21/bin/java -XX:+UseParallelGC -cp /tmp/WR591.S12.J8-tla2tools.jar tlc2.TLC -cleanup -workers 1 -config Views.cfg Views.tla
```

The proof command takes the actual app and producer merge commits, the producer
checkout for ancestry, and an existing signed-in loopback CDP endpoint. It exits
0 on exact observations, 1 on an assertion failure on containing releases, and
78 for missing releases, identity, session or positive cohorts. Synthetic fixture
mode is explicitly labelled and proves no production behavior.
