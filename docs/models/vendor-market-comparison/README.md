# Vendor market comparison

The Market view uses the parsed `vendor-markets.v1` snapshot. A null selected market shows the comparison. A canonical slug shows the existing market and Regional detail. Vendor links use the existing record dialog and retain the originating market parameters when closed.

## System design

The public `mountVendorMarkets` interface is unchanged. The comparison builds one vendor-ID lookup and reads explicit memberships. Counts come from the producer and the existing parser verifies distinct identity and count equality. Office totals count declared memberships. Coverage text never creates membership. Regional groups render separately.

Alternative considered: a third top-level view with its own selection and request. The chosen design reuses the Market view and null selection, avoiding duplicated request ownership and URL state.

One bounded read returns at most 100 markets and 5,000 memberships. Rendering is linear in memberships plus vendor lookup construction. At ten times current populated fixtures, DOM size grows first; pagination or a producer cap change would need a new product decision. There is no fan-out or N+1 request. The existing transport has a 15-second timeout, no automatic retry, and an explicit Refresh control after failure. Failed reads refuse stale counts. Refresh preserves the selected slug. Effects abort on view change, unmount, and session invalidation. No new cache, storage, queue, writes, or idempotency keys apply.

## Statechart

`vendors.mmd` models browsing and reading as separate regions. Regenerate outside the checkout with the installed statechart skill's `from-chart` command. Set `TLA2TOOLS` to a local tla2tools.jar and `JAVA` to Java 11 or later. The model abstracts record-detail loading and producer alias normalization; browser tests cover both integration paths.

| Transition | Behavior test in test/vendor-markets.browser.ts |
| --- | --- |
| Open markets; read succeeds; open market; compare all; refresh | all-market comparison preserves distinct identity and declared coverage |
| Open vendor; return to comparison; return to market | comparison and selected market return from the existing vendor detail |
| Registry empty; return to Category | market membership, multi-market, Regional, refresh and empty |
| Read fails; refresh recovers | producer resolves aliases; unavailable retries; session retirement erases answers |
| Session ends; Category switch cancels late success and failure | category switch and session retirement fence late success and failure |

## Production proof

After the containing release, run `node scripts/prove-vendor-markets.ts --origin https://app.doctorcre.com --expected-commit <merge-commit> --cdp-url <signed-in-CDP-endpoint> --screenshot-dir <private-output-directory>`.

The proof checks release ancestry, every comparison membership, count, office total, stable reference, and coverage string against the parsed registered read. It then checks each existing market detail and Regional links at 1440 and 390 in light and dark. Exit 0 requires populated multi-market and Regional evidence. Exit 1 means an assertion failed on a containing release. Exit 78 means evidence is insufficient, including an empty reviewed registry. Empty UI is checked before exit 78.
