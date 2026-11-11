# Vendor market comparison

The Market view uses the parsed `vendor-markets.v1` snapshot. A null selected market shows the comparison. A canonical slug shows the existing market and Regional detail. Vendor links use the existing record dialog and retain the originating market parameters when closed.

## System design

The public `mountVendorMarkets` interface is unchanged. The comparison builds one vendor-ID lookup and reads explicit memberships. Counts come from the producer and the existing parser verifies distinct identity and count equality. Office totals count declared memberships. Coverage text never creates membership. Regional groups render separately.

Alternative considered: a third top-level view with its own selection and request. The chosen design reuses the Market view and null selection, avoiding duplicated request ownership and URL state.

One bounded read returns at most 100 markets and 5,000 memberships. Rendering is linear in memberships plus vendor lookup construction. At ten times current populated fixtures, DOM size grows first; pagination or a producer cap change would need a new product decision. There is no fan-out or N+1 request. The existing transport has a 15-second timeout, no automatic retry, and an explicit Refresh control after failure. Failed reads refuse stale counts. Refresh preserves the selected slug. Effects abort on view change, unmount, and session invalidation. No new cache, storage, queue, writes, or idempotency keys apply.

## Statechart

`vendors.mmd` models browsing and reading as separate regions. Regenerate outside the checkout with the installed statechart skill's `from-chart` command. Set `TLA2TOOLS` to a local tla2tools.jar and `JAVA` to Java 11 or later. The model abstracts record-detail loading and producer alias normalization; browser tests cover both integration paths.

| Transition | Executed behavior test in test/vendor-markets.browser.ts |
| --- | --- |
| Browse: [*] → Category | Category settles and reloads at exactly /vendors |
| Browse: Category → Comparison (open markets) | all-market comparison preserves distinct identity and declared coverage 390 light |
| Browse: Comparison → Selected (open market) | all-market comparison preserves distinct identity and declared coverage 390 light |
| Browse: Selected → Comparison (compare all markets) | all-market comparison preserves distinct identity and declared coverage 390 light |
| Browse: Comparison → Detail (open vendor) | comparison and selected market return from the existing vendor detail |
| Browse: Selected → Detail (open vendor) | comparison and selected market return from the existing vendor detail |
| Browse: Detail → Comparison (return to comparison) | comparison and selected market return from the existing vendor detail |
| Browse: Detail → Selected (return to market) | comparison and selected market return from the existing vendor detail |
| Browse: Comparison → Category (open category) | Ready comparison read returns to Category |
| Browse: Selected → Category (open category) | Market selection then Category replaces URL state and reloads at exactly /vendors |
| Browse: Category → Retired (session ends) | Category session retirement removes registry and fences late success; Category session retirement removes registry and fences late failure |
| Browse: Comparison → Retired (session ends) | Comparison session retirement removes registry and fences late success; Comparison session retirement removes registry and fences late failure |
| Browse: Selected → Retired (session ends) | Selected session retirement removes registry and fences late success; Selected session retirement removes registry and fences late failure |
| Browse: Detail → Retired (session ends) | Detail session retirement removes the underlying comparison |
| Reading: [*] → Idle | Category settles and reloads at exactly /vendors |
| Reading: Idle → Loading (open markets) | all-market comparison preserves distinct identity and declared coverage 390 light |
| Reading: Loading → Ready (read succeeds) | all-market comparison preserves distinct identity and declared coverage 390 light |
| Reading: Loading → Empty (registry empty) | comparison unavailable and empty states recover without stale counts |
| Reading: Loading → Unavailable (read fails) | comparison unavailable and empty states recover without stale counts |
| Reading: Ready → Loading (refresh) | all-market comparison preserves distinct identity and declared coverage 390 light |
| Reading: Empty → Loading (refresh) | comparison unavailable and empty states recover without stale counts |
| Reading: Unavailable → Loading (refresh) | comparison unavailable and empty states recover without stale counts |
| Reading: Ready → Loading (open market) | all-market comparison preserves distinct identity and declared coverage 390 light |
| Reading: Ready → Loading (compare all markets) | all-market comparison preserves distinct identity and declared coverage 390 light |
| Reading: Loading → Idle (open category) | category switch and session retirement fence late success and failure |
| Reading: Ready → Idle (open category) | Ready comparison read returns to Category |
| Reading: Empty → Idle (open category) | Empty comparison read returns to Category |
| Reading: Unavailable → Idle (open category) | Unavailable comparison read returns to Category |
| Reading: Idle → Closed (session ends) | Category session retirement removes registry and fences late success; Category session retirement removes registry and fences late failure |
| Reading: Loading → Closed (session ends) | Loading session retirement removes registry and fences late success; Loading session retirement removes registry and fences late failure |
| Reading: Ready → Closed (session ends) | Comparison session retirement removes registry and fences late success; Comparison session retirement removes registry and fences late failure |
| Reading: Empty → Closed (session ends) | Empty session retirement removes registry and fences late success; Empty session retirement removes registry and fences late failure |
| Reading: Unavailable → Closed (session ends) | Unavailable session retirement removes registry and fences late success; Unavailable session retirement removes registry and fences late failure |

## Production proof

After the containing release, run `node scripts/prove-vendor-markets.ts --origin https://app.doctorcre.com --expected-commit <merge-commit> --cdp-url <signed-in-CDP-endpoint> --screenshot-dir <private-output-directory>`.

The proof checks release ancestry, every comparison membership, count, office total, stable reference, and coverage string against the parsed registered read. It then checks each existing market detail and Regional links at 1440 and 390 in light and dark. Exit 0 requires populated multi-market and Regional evidence. Exit 1 means an assertion failed on a containing release. Exit 78 means evidence is insufficient, including an empty reviewed registry. Empty UI is checked before exit 78.
