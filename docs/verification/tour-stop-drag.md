# Tour stop reorder

The composer owns rows, identity, undo, review and persistence. The typed gesture module owns pointer capture, hit testing, edge scrolling and cancellation. Its only edit is `move(sourcePropertyId, targetPropertyId)`. Pointer and Up/Down use `reorderFlexibleStops` and `rememberEdit`. Fixed appointments and inactive stops retain their slots and timing. Labels travel with properties. Drag previews never renumber canonical stops or write records.

Design alternatives were native HTML drag and drop, which lacks reliable touch input, and a Pointer Events handle. The handle uses pointer capture and leaves ordinary card content available for scrolling. A single animation frame scrolls at most 16 pixels per frame during the gesture. Drop, Escape, cancellation, blur, rerender and session retirement cancel it. At 100 rows, hit testing uses the DOM and reorder is linear. At 10 times that load, the existing 100-property composer cap refuses the route. No new storage, queue, cache, network call, retry policy or route writer is introduced. The existing composer owns route version guards, bounded reads, write idempotency and uncertain-outcome recovery.

The Model the Domain principle keeps gesture state in a discriminated union. Design and debt passes kept gesture lifetime behind one destroy method and removed the independent Up/Down swap logic. Delegation-based skill steps were performed directly because the builder brief prohibits subagents. Independent taste scoring belongs to the coordinator's separate reviewer.

## Transition tests

All tests are in `test/tour-composer.test.mjs`. The diagram is an abstract lifecycle inventory, not a model of HTTP interleavings. TLC checks the three retirement invariants. Executed browser tests exercise actual pointer capture, touch, scrolling and cleanup.

| Transition | Test |
| --- | --- |
| idle, dirty or undo to dragging | phone and iPad composers fit the viewport and reduced motion leaves every state legible |
| dragging to dirty | drag pointerup preserves identities and one undo restores order without a write |
| dragging to cancelled, Escape and restart | phone and iPad composers fit the viewport and reduced motion leaves every state legible |
| dragging to cancelled, pointer cancel | drag pointercancel preserves identities and one undo restores order without a write |
| dragging to idle, unchanged or outside drop | drag cancellation covers Escape, outside drop, unchanged drop and lost capture |
| idle, dirty or undo to dirty, keyboard | Dot Tour: keyboard reorder keeps focus on the moved property at route boundaries |
| dirty to undo | drag pointerup preserves identities and one undo restores order without a write |
| dirty to saving to reviewed to saving to idle | drag and keyboard produce identical save mapping, review digest and acceptance |
| saving to unknown to reconciled to saving | lost stop response requires a successful reconciliation read and retries the same request without duplicates |
| saving to dirty, conflict | stale version refusal preserves edits, prevents acceptance and fresh-key retries, and permits deliberate reload |
| dragging to retired | drag retires on session invalidation and cannot change or save the old Tour |
| other states to retired | review 2: composer intent cannot retry under a changed authenticated session; session invalidation retains an uncertain Tour write under its original session binding |
| embedded parent scrolling and hit testing | embedded drag edge scroll moves the deal workspace and keeps property hit testing aligned |
| fixed and inactive target refusal | fixed, held and excluded stops keep their slots and timing during flexible reorder |

## Production proof

Run `node scripts/prove-tour-stop-drag.ts --origin https://app.doctorcre.com --expected-commit MERGE_SHA --tour-url SIGNED_IN_DEAL_TOUR_URL --storage-state PRIVATE_PLAYWRIGHT_STATE_PATH --timeout-ms 120000` after a containing deployment. The coordinator supplies the actual merge revision, an editable existing Tour with at least two flexible stops, and a provisioned private state file. The runner uses the shared release reader, refuses older or unrelated releases, blocks every non-read request, checks exact property order after drag and Undo at 1440 and 390 in both color schemes, then reloads and compares the canonical order. It never saves. Exit 0 proves the observations, 1 denotes an assertion failure, and 78 denotes insufficient release or session evidence. The browser test invokes the observation for a passing fixture and a broken pointer-up fixture. CLI fixtures also run the complete runner against contract-checked synthetic Tour reads and require exit 0 for the four observations and exit 1 for the broken pointer-up fixture. The production runner itself needs deployed authenticated evidence; fixture observation is not production proof.

Provider-backed travel preview remains open. This change supplies no travel estimate.
