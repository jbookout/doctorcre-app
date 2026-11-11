# Tour entrance navigation

The itinerary and Tour day use `src/ui/tour-navigation.ts` to adapt the authenticated `routes[].navigation` response. The producer is pinned in `contracts/tour-map.v1.json` to CARR PR 3185 at `838237d3cef0c4e783ccc26aff180759890b3818`. The copied producer type and synthetic fixture live under `test/fixtures/tour-navigation/`. The fixture extends the producer example with the complete checks required by the existing pinned map module and the renderer version actually shipped here.

## System design

The existing immutable map module owns coordinates, outbound links and return markers. One typed adapter validates the new evidence shape for both callers. A second design, extending the vendored map module to read the response directly, would duplicate the producer seam and invalidate its byte pin. The adapter keeps that pin intact. Browser entry points supply the validator to the itinerary adapter; plain Node consumers can load the ordered itinerary without generated UI bundles. Tour day loads the validator only at browser bootstrap.

The existing detail read supplies every stop without additional stop requests. The itinerary adds one authenticated session read when its library refreshes. Existing request deadlines and refresh visibility limits apply. There are no new retries, queues, writes, provider calls or network polling loops. The adapter runs linearly in the small itinerary; matching stops currently uses a bounded array lookup per stop. At ten times the load, the producer detail read remains the first capacity limit.

Evidence has a five-minute in-memory lease from the producer's `as_of`. Expiry removes navigation; it never serves a stale link. The timer is replaced on update and cleared on destruction. Coordinates and receipts refresh atomically from the same detail response. Missing evidence preserves the ordered fallback. Offline Tour day withholds navigation. Session storage binds selection and return to user, session, route identity and projection. A return marker also records projection version/digest and promotion receipt identity/digest. No secret or business write is added.

## Statechart and executable coverage

The chart is `tour-navigation.mmd`. These transitions map to the named tests.

| Transition | Test |
| --- | --- |
| Unknown to eligible | `matching reviewed detail exposes exact entrance coordinates` |
| Unknown to absent | `absent unknown stale route projection receipt and component evidence hide navigation` |
| Eligible to stale; evidence refreshed; view destroyed | `mounted navigation evidence lease expiry`, `replacement`, and `destruction` |
| Select stop; outbound; return to same stop | `itinerary Navigate exact coordinates hidden evidence and return at phone and desktop in both themes` |
| Route replaced; user changed; session retired; session reopened | Same browser test, after the return assertion |
| Fresh matching evidence after absence | Same browser test, when the fixture is refreshed after session retirement |

`TourNavigation.tla` is the executable source of truth. `TapNavigate` requires eligible evidence, matching the mounted itinerary's promotion guard. The Mermaid chart is a presentation projection; regenerating an unguarded skeleton does not replace the model.

Run from this directory with a locally installed TLA+ tools jar:

```sh
/opt/homebrew/opt/openjdk@21/bin/java -cp "$TLA2TOOLS" tlc2.TLC -cleanup -config TourNavigation.cfg TourNavigation.tla
```

The configuration checks TypeOK and all four navigation invariants. This model abstracts stop identity and treats expiry as an event. It does not prove wall-clock timing, receipt authenticity or user/session isolation. `mounted navigation evidence lease expiry`, `replacement`, and `destruction` exercise real mounted callbacks with fake timers. The proof CLI suite exercises equal/descendant acceptance, older/unrelated/unknown refusal, late launch and stalled evaluation with zero surviving owned browser processes.

## Production proof

After a containing app release and CARR PR 3185 are deployed, run `node scripts/prove-tour-navigation.ts --commit APP_MERGE_SHA --tour APPROVED_TOUR_UUID --storage-state PRIVATE_SIGNED_IN_STATE`. The CLI reads `/app-release` through the shared release reader, checks commit ancestry, loads the real itinerary at 390 and 1440 in light and dark, compares the generated URL exactly with the authenticated evidence, clicks without leaving the browser and reloads to verify the same stop. It refuses all non-GET browser requests. Exit 0 passes, 1 is an assertion failure, and 78 means insufficient evidence.

The browser suite executes the actual CLI with passing evidence and a deliberately corrupted-coordinate asset. Synthetic fixtures do not establish a live route, production release, independent taste score or actual OS maps handoff. A naturally approved route with current matching entrance, rights and promotion receipts, including `maplibre-6.4.1`, is required. A separate device observation must prove the native maps handoff.
