# Static asset capacity

The artifact file inventory and a document's HTTP request count measure different
things. A browser loads one page's dependency graph, not every deployed page.

The old `test/request-budget.test.mjs` asserted that the entire artifact had at
most 400 files. It came from commit `f35dd21aca5244545fadc445b9e6c6bd1c144ea3`,
“Bound app polling loops (work in progress) (#565)”. Its purpose was a conservative
proxy for the initial static requests within a 1,000-request quiet-tab allowance.
It was an application budget, not a hosting constraint. The actual browser check
in `test/progress-work-browser.test.mjs` still measures at most 400 asset requests,
600 fetch/XHR attempts, and 1,000 total first-party requests over 24 simulated hours.
These runtime limits are unchanged.

## Alternatives

1. Bundle UI entries into shared chunks. This can reduce duplicated bytes, but
   shared chunks can increase file count and change page loading. It does not fix
   conflating deployment inventory with per-page requests.
2. Drop deployed source maps, fonts, or images. There are no deployed source maps
   to remove. Deleting useful assets solely to meet the proxy would be temporary.
3. Separate the deployment capacity check from the browser request check. Selected.
   Preserve the real browser limits; enforce the provider ceiling during artifact
   assembly and reserve capacity before it is exhausted.

[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets)
allow 20,000 static asset files per Free Worker version and 100,000 on Paid.
Use the lower ceiling without assuming an account plan. The artifact builder
counts all payload files plus `artifact-manifest.json` and rejects fewer than
2,000 remaining slots, a 10% reserve. Exactly 18,000 deployed files passes;
18,001 fails. Build output and the artifact test report count, limit, and headroom.
The tarball, checksum, and duplicate manifest outside `dist/site` are release
packaging, not uploaded static assets. `/app-release` is a Worker response.

## System design

Artifact assembly owns admission of the deterministic deployment inventory.
`assetBudget(payloadFiles)` returns capacity or throws before output is published.
This is a synchronous count check with constant memory and time. At ten times
roughly 400 payload files, capacity remains below 20,000. The reserve check fails
first at 18,001 deployed files. No UI, caching, database, network, queue, retry,
rate-limit, or idempotency behavior changes. Those concerns are not applicable to
this pure local calculation. Existing release digest and source fencing remain.

## Verification

Run `node --test test/asset-budget.test.ts test/request-budget.test.mjs` and
`npm run build`. The unit test exercises the exact reserve boundary and overflow.
The integration test builds the real artifact; the ordinary build also enforces
admission. Keep the browser's measured quiet-tab test in the hosted shards.

PRODUCTION PROOF: after deployment contains the merge commit, verify the release
source; count `artifact-manifest.json.files.length + 1` from that deployed release,
require at least 2,000 slots below 20,000, then open the app and confirm Home loads
without failed first-party module requests. No production proof is claimed by
this build-only unit.
