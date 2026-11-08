# Quick switcher partial transport verification

The shell creates the authenticated client. `readQuickSwitcherSources` starts two callbacks once and settles them independently. A rejected callback becomes `null`; fulfilled payloads pass unchanged to `destinations`. The existing parser owns admission and messages. The existing dialog owns Retry, filtering, recents, and retirement.

The alternatives were individual catches in the JavaScript shell and a typed join in the existing switcher module. The typed join keeps new behavior in TypeScript without duplicating parsers or introducing a service. The shell only supplies bound callbacks. Synchronous throws become rejected promises before the two-source join.

## System design

Each open or manual Retry starts at most two parallel source reads. There is one attempt in flight and no automatic retry. Typing and kind changes filter the current admitted set without requests. At ten times the record count, producer bounds and linear local indexing remain the first limits. There are no per-record reads or N+1 queries.

Each source retains its existing ten-second deadline. One failure marks that source unavailable after both reads settle; both failures retain pages and Retry. Client creation failure follows the whole-read error path. A healthy source can wait for the other source's deadline. This change does not stream progressive results.

Retry replaces business results. Recents contain IDs and intersect the admitted set. No new cache, queue, storage, backend call, write, send, or idempotency key applies. The failure threshold is one failed source per attempt; the existing message is the alert and existing partial results are the fallback. Session invalidation closes the dialog and retires the shell before a late result can publish.

## Statechart

[The four-region chart](quick-switcher-partial-transport.mmd) separates dialog lifetime, board, contacts, and displayed results. Fulfilled source states mean admitted payloads; malformed fulfilled responses take the unavailable branch after parsing. Timeout is a rejected read with a distinct modeled state. Filtering is a local self-transition. Selection closes the dialog through the existing navigation path.

Run in owned scratch storage, with Java 11 or newer and `TLA2TOOLS` pointing at `tla2tools.jar`.

```sh
node /Users/booko/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/statechart/scripts/statechart.mjs from-chart quick-switcher-partial-transport.mmd --module QuickSwitcherPartialTransport --png
```

The initial unguarded chart admitted impossible results and retired-session reopening. The final chart includes the real lifetime, settled-source, and Retry guards. After adding source annotations to the generated model, the same command passes again. The retained build report names `summary.json`, `stories.md`, the generated model, and rendered PNG. It records 59 model states, 174 transitions, and zero rule violations.

The finite model abstracts transport bodies, concrete record IDs, query text, and history contents. It models source settlement rather than wall time. It represents the old-attempt fence by the closed lifetime; browser tests additionally prove that an old completion cannot replace a newly opened dialog. The two-read cap and history clearing also have executable browser checks; the chart's structural predicates do not measure HTTP counts or storage contents.

| Rule | Modeled condition | Code |
| --- | --- | --- |
| KeepBoard | Admitted board plus rejected contacts cannot produce unavailable-only pages | `src/ui/quick-switcher.tsx:72`, `:54` |
| KeepContacts | Admitted contacts plus rejected board cannot produce unavailable-only pages | `src/ui/quick-switcher.tsx:72`, `:54` |
| TruthfulUnavailable | Two admitted sources cannot claim both unavailable | `src/ui/quick-switcher.tsx:54` |
| RetiredHidden | Retired lifetime cannot reach full results | `js/app-shell.js:43`, `src/ui/quick-switcher.tsx:101`, `:144` |
| OldAttemptHidden | Closed lifetime cannot reach partial business results | `src/ui/quick-switcher.tsx:92`, `:134`, `:144` |
| FilterNoRead | Filtering cannot turn displayed board results into a pending board read | `src/ui/quick-switcher.tsx:124`, `:145`, `:160` |
| PairCap | Full results cannot start another contacts read without Retry or reopening | `src/ui/quick-switcher.tsx:129`, `:145`, `:168` |

## Transition coverage

All named tests are in `test/quick-switcher-partial-read-browser.test.mjs` unless otherwise specified. The shell cases click the real global control and use the real live adapter against synthetic routed HTTP. Successful relationship fixtures pass `validNetwork`; board schema and action fields bind to the pinned board contract, and both bodies pass through the production adapter. These are synthetic observations, not production evidence.

| Transition | Named test |
| --- | --- |
| Open; either settlement order; show all records | `shell full source reads run in parallel, board finishes first`; `shell full source reads run in parallel, contacts finishes first` |
| Board fulfills; contacts HTTP, network, or timeout failure | `shell preserves deal and task results when contacts http`, `network`, `timeout` |
| Contacts fulfills; board HTTP, network, or timeout failure | `shell preserves contact results when board http`, `network`, `timeout` |
| Both fail; show unavailable pages; distinguish successful empty | `shell keeps pages and Retry when both sources fail, empty is successful` |
| Malformed fulfilled payload | `shell preserves deal and task results when contacts malformed`; `shell preserves contact results when board malformed`; existing malformed-section tests |
| Partial; Retry; loading; full results | `shell Retry replaces partial results with current results and removes inaccessible recents` |
| Partial; Retry; narrower result; remove inaccessible results and recents | Same Retry test |
| Local query and kind changes | Every `shell preserves ...` case asserts exactly one pair after filtering |
| Select current destination by Enter or pointer | `partial source Deal`, `Task`, and `Contact opens its destination in light/dark at 390/1440px` |
| Escape or outside close; late settlement | `shell close fences late partial reads after Escape`; `after outside` |
| Close; reopen; old settlement | `shell old completion cannot replace a reopened dialog` |
| Session loss while pending, including authoritative HTTP denial | `shell close fences late partial reads after invalidate`; `after denied` |
| Session loss after partial settlement | `shell session invalidation clears settled board partial results`; `contacts partial results` |
| Fixture contract admission | `shell fixtures match pinned contracts through the production adapter` |

The kind-filter and original switcher suites retain keyboard selection, focus, fit, and accessibility checks. Local screenshots show the unavailable message and task result before Retry, then the same query and task filter after full recovery.

## PRODUCTION PROOF

After a deployed release contains the merge commit, read `/app-release` through `scripts/app-release-reader.mjs` and verify source containment with the existing `scripts/check-release-source.mjs` pattern. An older or unrelated release is insufficient evidence.

In a signed-in proof-owned tab, independently capture the natural successful board and relationship responses. Search and open one deal, task result, and contact. Compare exact admitted IDs, labels, and destination URLs. Task navigation still opens its parent deal and is not exact-task proof.

Intercept only the contacts read to fail locally while the real board read succeeds. Observe the contacts-unavailable message and exact admitted deal/task destinations. Reverse the failure and verify a real contact. Restore routing and Retry to recover current full results. Inject no success bodies and perform no business mutation or send. Close owned tabs and restore interception. Missing natural records, session, or release containment means insufficient evidence. AC-SWITCHER remains partial pending that proof and broader indexing/navigation coverage.

No production-proof CLI is added or changed, so a CLI fixture pass/failure run is not applicable to this PR. The shell regression supplies the local success and failure observations.

## Source study and repository impact

The planning report studied T3 commit `9e85538535c8553901351112ab02dd1dd62db5ee`, `CommandPaletteLookups.ts` and `CommandPaletteResults.tsx:40`. Those files separate supplied groups from rendering. They do not establish this transport policy. No T3 source is copied.

`jbookout/doctorcre-app` owns this join and verification. `DoctorCRE/carr-system` needs no change because existing authenticated contracts suffice. `jbookout/software-factory` needs no change because no workflow or delivery gate changes.
