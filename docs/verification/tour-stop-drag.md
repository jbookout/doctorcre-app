# Tour stop reorder

The composer owns rows, identity, undo, review and persistence. The typed gesture module owns pointer capture, hit testing, edge scrolling and cancellation. Background refresh treats an active gesture as local editing so a focus wake cannot replace its rows. Its only edit is `move(sourcePropertyId, targetPropertyId)`. Pointer and Up/Down use `reorderFlexibleStops` and `rememberEdit`. Fixed appointments and inactive stops retain their slots and timing. Labels travel with properties. Drag previews never renumber canonical stops or write records.

Design alternatives were native HTML drag and drop, which lacks reliable touch input, and a Pointer Events handle. The handle uses pointer capture and leaves ordinary card content available for scrolling. A single animation frame scrolls at most 16 pixels per frame during the gesture. Drop, Escape, cancellation, blur, rerender and session retirement cancel it. At 100 rows, hit testing uses the DOM and reorder is linear. At 10 times that load, the existing 100-property composer cap refuses the route. No new storage, queue, cache, network call, retry policy or route writer is introduced. The existing composer owns route version guards, bounded reads, write idempotency and uncertain-outcome recovery.

The Model the Domain principle keeps gesture state in a discriminated union. Design and debt passes kept gesture lifetime behind one destroy method and removed the independent Up/Down swap logic. Delegation-based skill steps were performed directly because the builder brief prohibits subagents. Independent taste scoring belongs to the coordinator's separate reviewer.

## Transition tests

Composer state tests are in `test/tour-composer.test.mjs`. New Chromium cases are in `test/tour-stop-drag.browser.ts`. The diagram is an abstract lifecycle inventory, not a model of HTTP interleavings. TLC checks the three retirement invariants. Executed browser tests exercise actual pointer capture, touch, scrolling and cleanup.

| Transition | Test |
| --- | --- |
| idle to dragging, Hold flexible stop handle | mouse and touch drag preserve exact order and Undo at 390px/1440px light/dark |
| dirty to dragging, Hold flexible stop handle | mouse and touch drag preserve exact order and Undo at 390px/1440px light/dark |
| dragging to cancelled, Escape or pointer cancel or outside drop | drag cancellation covers Escape, outside drop, unchanged drop and lost capture; drag pointercancel preserves identities and one undo restores order without a write |
| dragging to idle, Drop without moving | drag cancellation covers Escape, outside drop, unchanged drop and lost capture: unchanged |
| dragging to dirty, Drop on flexible stop | drag pointerup preserves identities and one undo restores order without a write |
| cancelled to dragging, Hold flexible stop handle | cancelled drag can restart and complete without a write |
| idle to dirty, Press Up or Down | Dot Tour: keyboard reorder keeps focus on the moved property at route boundaries |
| dirty to dirty, Press Up or Down | Dot Tour: keyboard reorder keeps focus on the moved property at route boundaries |
| dirty to undo, Undo last edit | drag pointerup preserves identities and one undo restores order without a write |
| undo to dragging, Hold flexible stop handle | mouse and touch drag preserve exact order and Undo at 390px/1440px light/dark |
| undo to dirty, Press Up or Down | Dot Tour: keyboard reorder keeps focus on the moved property at route boundaries |
| dirty to saving, Explicit Save | drag and keyboard produce identical save mapping, review digest and acceptance |
| saving to unknown, Response lost | lost stop response requires a successful reconciliation read and retries the same request without duplicates |
| unknown to reconciled, Explicit Reconcile | lost stop response requires a successful reconciliation read and retries the same request without duplicates |
| reconciled to saving, Explicit Retry same request | lost stop response requires a successful reconciliation read and retries the same request without duplicates |
| saving to reviewed, Saved draft and explicit review | drag and keyboard produce identical save mapping, review digest and acceptance |
| reviewed to saving, Explicit Accept | drag and keyboard produce identical save mapping, review digest and acceptance |
| saving to idle, Accepted readback | drag and keyboard produce identical save mapping, review digest and acceptance |
| saving to dirty, Conflict preserves edits | stale version refusal preserves edits, prevents acceptance and fresh-key retries, and permits deliberate reload |
| idle to retired, Session changes | session retirement from idle removes Tour edits and refuses writes |
| dragging to retired, Session changes | drag retires on session invalidation and cannot change or save the old Tour |
| cancelled to retired, Session changes | session retirement from cancelled removes Tour edits and refuses writes |
| dirty to retired, Session changes | session retirement from dirty removes Tour edits and refuses writes |
| undo to retired, Session changes | session retirement from undo removes Tour edits and refuses writes |
| saving to retired, Session changes | session retirement from saving removes Tour edits and refuses writes |
| unknown to retired, Session changes | session retirement from unknown removes Tour edits and refuses writes |
| reconciled to retired, Session changes | session retirement from reconciled removes Tour edits and refuses writes |
| reviewed to retired, Session changes | session retirement from reviewed removes Tour edits and refuses writes |
| signedIn to signedOut, Session changes | drag retires on session invalidation and cannot change or save the old Tour |

## Production proof

For a shared signed-in browser, replace `--storage-state` and its path with `--cdp-url http://127.0.0.1:9333`. The proof closes only its acquired pages and disconnects after pending acquisitions settle. Existing tabs and the borrowed browser remain open. Legacy standalone route-editor Tours, do not qualify as an editable deal workspace. Missing qualification exits 78; no Tour is created. See [proof runner lifetime](proof-runner-lifetime.md) for verdict and cleanup coverage.

Run `node scripts/prove-tour-stop-drag.ts --origin https://app.doctorcre.com --expected-commit MERGE_SHA --tour-url SIGNED_IN_DEAL_TOUR_URL --storage-state PRIVATE_PLAYWRIGHT_STATE_PATH --timeout-ms 120000` after a containing deployment. The coordinator supplies the actual merge revision, an editable existing Tour with at least two flexible stops, and a provisioned private state file. The runner uses the shared release reader, refuses older or unrelated releases, blocks every non-read request, checks exact property order after drag and Undo at 1440 and 390 in both color schemes, then reloads and compares the canonical order. It never saves. Exit 0 proves the observations, 1 denotes an assertion failure, and 78 denotes insufficient release or session evidence. The browser lane checks mouse and touch, Undo, Escape and embedded edge scrolling at phone and desktop widths. Recorded Tour responses pass through the real composer reader. Fixture asset paths resolve under the checkout root and reject encoded escapes; the shared descriptor server refuses encoded request paths. HTML scripts are removed with DOM operations, not a sanitizer regex. CLI fixtures also run the complete runner against contract-checked synthetic Tour reads and require exit 0 for the four observations and exit 1 for broken pointer-up and near-miss identity fixtures, and exit 78 for a missing stored session on a containing release. Browser and session acquisition failures are classified before app assertions begin. The production runner itself needs deployed authenticated evidence; fixture observation is not production proof.

Provider-backed travel preview remains open. This change supplies no travel estimate.
