# Saved deal space searches

The deal Tour workspace saves and reopens a search brief through CARR. It reruns the saved criteria, preserves the previous results on failure, and passes chosen canonical property IDs to the existing Tour cart draft. The cart's existing save and add-stops actions retain ownership of selection and route persistence.

## System design

The `SavedSearches` module owns draft, saved version, pending request key, selection and request lifecycle. The React island owns presentation. The Tour workspace adapter supplies its existing session-aware MCP transport, property hydration and cart handoff. CARR owns saved records and canonical query execution. Only canonical filters execute. Budget, timing and other requirements remain descriptive text.

Two interfaces were considered. Mounting on the parent deal page required another cart adapter across the embedded editor. Mounting in the existing Tour workspace keeps one cart owner and one route persistence path. The latter was chosen. The interface accepts the actual browser adapter and the recorded-response adapter used by acceptance tests.

Reads return at most 100 search briefs and runs return at most 100 property IDs. Existing property hydration consumes at most 20 pages of 100 records. Requests are serial within the search panel, have a 15-second deadline, and do not retry automatically. One failed call stops until the user retries. The retained request key makes a repeated unconfirmed write idempotent. Version conflicts refresh the saved base while retaining the draft. Tests cover the pending key, conflict base, duplicate initiation, malformed responses and retirement.

At current load and ten times that load the browser keeps the same bounded result sets. Server-side search capacity and policy remain CARR's responsibility. Property hydration is the first latency limit and is bounded by the existing page budget. It does not fan out or perform a request for each result. The workspace caches known property labels only in memory. Session retirement clears them and the search state. Saved searches have no local storage cache. New result badges compare consecutive confirmed runs in the open panel; reloading establishes a new comparison baseline.

Search writes and runs require their exact current version. Stale results remain visible with their prior criteria but cannot enter the cart. A failed run leaves the prior confirmed result IDs visible. Selecting a search or editing while a write is in flight is disabled. Session retirement clears presentation and rejects late responses. Existing Tour selection saving independently checks its cart version and confirms its readback.

No queues, background jobs, new database access, provider calls, map renderer or route persistence were added. External-call failure handling reuses the existing request deadline and session invalidation. There is no automatic retry loop or new operational alert channel.

## Producer binding

The schema in `src/ui/deal-space-search-contract.ts` and recorded responses in `test/fixtures/deal-space-searches/responses.json` come from DoctorCRE/carr-system commit `0d31536220b19be5c6a6fd2b63a8d60a35ab6fd1`, PR 3187. Source paths are `mcp-server/contracts/deal-space-searches.v1.json` and `mcp-server/test/fixtures/deal-space-searches.json`. The schema is exported as TypeScript data so the existing source-only UI bundler can read it without opening another artifact import path. Production and fixtures cross the same Ajv validator and deal-identity parser.

This consumer must remain draft until that producer is merged and deployed. This build does not establish production persistence or independent taste approval.

## Statechart and verification

`deal-space-searches.mmd` separates search progress and session access. The chart abstracts network outcomes and time into discrete events. It does not model CARR internals, transport cancellation or route saves. TLC checked `TypeOK`, `NoRetiredWrite` and `NoRetiredRun`. It found 13 reachable states, 33 transitions and no broken invariant. Evidence is retained in `/tmp/wr591-j3-model`.

Regenerate by copying the Mermaid input into a scratch directory, then running the statechart skill's `from-chart` command with `JAVA` and `TLA2TOOLS` pointing to an installed Java runtime and tla2tools.jar. This avoids generating build helpers into the application source tree.

Transition coverage lives in `test/deal-space-searches.test.ts` and `test/deal-space-searches.browser.ts`. The model tests cover editing/saving/saved, reopen, archive/restore, running/failure/retry, conflict/retry, stale detection, current results/cart and session retirement. Browser acceptance repeats the visible lifecycle at 1440 and 390 widths in light and dark. It also checks horizontal overflow and records screenshots outside the checkout.

## Production proof

After the containing CARR and app releases, save a search on a real deal. Run `node scripts/prove-deal-space-searches.ts` with `--expected-commit`, `--deal-id`, `--search-id` and the signed-in browser's loopback `--cdp-url`. The proof requires a containing app release, reopens the search after reload, independently reads the registered CARR verb, compares every criterion and result ID exactly at both widths and themes, then cancels without cart handoff. Exit 0 means passed, 1 means disagreement on a containing release, and 78 means insufficient evidence. The CLI itself is read-only. The preceding real-deal save remains part of the release proof.

The proof reuses the existing bounded browser/release runner. Its shared tests cover equal/descendant/older/unrelated/unknown releases, late browser acquisition and stalled evaluation cleanup. Local fixture CLI checks exercise exact-match success and missing-result failure.
