# Calendar-month watch settings

`watch-months.mmd` models the independent request phase and visibility of the threshold controls. The model starts after a successful opening read. It abstracts numeric values and server internals. Browser tests check exact arrays, input validation and idempotency keys; the chart checks visibility across request and session transitions.

Regenerate in scratch space with the pstack statechart skill. Copy `watch-months.mmd` into an empty scratch directory, then run `node <statechart-skill>/scripts/statechart.mjs from-chart <scratch>/watch-months.mmd --out <scratch>/result --png` with `TLA2TOOLS` and `JAVA` configured. The command generates the model, configuration, mapping and diagram. No generated executable helper belongs in the app source tree.

The model has five reachable states. TypeOK and all three never rules hold. Its display names retain the chart state identifiers so the from-chart comparison remains exact.

Every transition has browser coverage in `test/watch-controls.browser.ts`.

| Transition | Test |
| --- | --- |
| Save valid settings; server confirms settings | canonical threshold units survive open refresh and self-change save |
| Reply is lost; retry same request and key | month policy edits validate both units and preserve frozen retries and conflicted drafts |
| Stale version refresh keeps draft | month policy edits validate both units and preserve frozen retries and conflicted drafts |
| Refresh watch; current watch arrives | canonical threshold units survive open refresh and self-change save |
| Sign out from ready, reading or unknown | sign-out from Ready, Loading and Uncertain removes confirmation and ignores late callbacks |
| Sign out while saving | recorded watch journey confirms, retries, reconciles and retires |
| Late reply arrives | month-bearing late read is discarded after session invalidation |

The browser tests additionally verify invalid edits send nothing, removal of either threshold list, unsorted arrays, range boundaries, both record types, radar behavior and unchanged pause, resume and remove commands.
