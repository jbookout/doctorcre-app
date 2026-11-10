# Quiet lead history model

The Mermaid source is the executable model. Copy it to an empty scratch directory before compiling. No hand-edited TLA file or hidden guard is required. Use the statechart skill's `from-chart` command, Java 11 or later, and a released `tla2tools.jar`.

```sh
mkdir -p /tmp/quiet-lead-history-model
cp docs/statecharts/quiet-lead-history.mmd /tmp/quiet-lead-history-model/history.mmd
TLA2TOOLS=/tmp/WR647.S28.J1-tla2tools.jar JAVA=/opt/homebrew/opt/openjdk@21/bin/java node /Users/booko/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/statechart/scripts/statechart.mjs from-chart /tmp/quiet-lead-history-model/history.mmd
```

Expected exit is 0, every invariant holds, and the spec draws the input back unchanged. The compiler writes the TLA model, configuration, mapping, `History-statechart/summary.json`, and `stories.md` beside that scratch source. The jar path above is the delivery session's installed TLC. Set it to the installed jar when reproducing elsewhere.

## Scope and code correspondence

Availability and rows change atomically on a completed current read. The `%% when` guards are executable guards, not display annotations. `js/leads-workspace-app.js:224` and `:227` reject stale success and refusal callbacks. `src/ui/quiet-leads.tsx` update method rejects every update after disposal. Its render function excludes rows outside ready. Closing retires to a named terminal screen, with a late-update self-loop.

History is one of all, created_at, or last_contact. The predicate at `src/ui/quiet-leads.tsx` render predicate matches that recorded basis before pagination. Row states abstract the matching collection, including the possibility of an empty collection. Owner and search further narrow that collection without changing its history class. The model distinguishes the first page from later pages. LastChange records whether the latest relevant action resets the page or navigates it. Every filter action and successful read resets both together. Loading may retain an internal offset while hiding rows; the successful refresh resets it.

The model omits actual row IDs, counts, owner strings, search text, arbitrary page numbers, network payloads, and read epoch numbers. Browser tests assert those values through the production parser and real renderer. Next and previous abstract eligible page navigation; their row-count eligibility is checked by browser tests. The proof region is an independent lifecycle overview. It does not formally prove release ancestry, resource ownership, transport safety, or exit codes. CLI tests check these contracts. This model checks finite safety, not liveness or the application source itself.

## Invariants and named tests

All test names below are literal names in `test/quiet-lead-history.browser.ts`, except where a file is named explicitly.

| Invariants | Named implementation tests |
| --- | --- |
| LoadingRows, LoadingNeverRows, LoadingContactedRows | history lifecycle clears idle and disposal, hides loading and refusal, retains selection on retry |
| RefusedRows, RefusedNeverRows, RefusedContactedRows | history lifecycle clears idle and disposal, hides loading and refusal, retains selection on retry |
| ClosedRows, ClosedNeverRows, ClosedContactedRows | history lifecycle clears idle and disposal, hides loading and refusal, retains selection on retry |
| NeverHistoryAll, NeverHistoryContacted | history intersects owner search and pages without RPC at 390; history intersects owner search and pages without RPC at 1440 |
| ContactedHistoryAll, ContactedHistoryNever | history intersects owner search and pages without RPC at 390; history intersects owner search and pages without RPC at 1440 |
| AllHistoryNever, AllHistoryContacted | history intersects owner search and pages without RPC at 390; history intersects owner search and pages without RPC at 1440 |
| PageReset | history intersects owner search and pages without RPC at 390; history intersects owner search and pages without RPC at 1440 |

## Transitions and named tests

Every edge with a repeated action label uses the corresponding test below. Initial arrows establish initial state and are exercised by each mount or CLI invocation.

| Action label | Named test |
| --- | --- |
| Open or refresh; Read succeeds; Refresh; Read refused; Retry; Session invalidated | history intersects owner search and pages without RPC at 390; history intersects owner search and pages without RPC at 1440; history lifecycle clears idle and disposal, hides loading and refusal, retains selection on retry |
| Show all history; Show no contact recorded; Show contact recorded; Change owner; Change search; Clear search; Next page; Previous page | history intersects owner search and pages without RPC at 390; history intersects owner search and pages without RPC at 1440 |
| Dispose; Late update | history lifecycle clears idle and disposal, hides loading and refusal, retains selection on retry; retirement, suspension, stale board completion, refusal retry and disposal in test/quiet-lead-owner-pages-browser.test.mjs |
| Containing release read; Registry and subjects available; Exact rows and stable release; Close acquired resources | actual CLI fixture succeeds and wrong visible ID and near-miss count fail; actual CLI release equal; actual CLI release descendant |
| Release unavailable | actual CLI release older; actual CLI release unrelated; actual CLI release unknown |
| Session registry or subjects unavailable | unreachable CDP is insufficient evidence; registry refusal and no eligible subjects exit 78 |
| Visible mismatch | actual CLI fixture succeeds and wrong visible ID and near-miss count fail |
| Deadline or changing release | changing release and stalled release are insufficient evidence; deadline cleanup stalled evaluation |
| Acquisition deadline | deadline cleanup late launch; late newPage closes before CDP disconnect and fresh connection sees no added tab |

All proof test names are in `test/prove-quiet-lead-history.test.ts`.
