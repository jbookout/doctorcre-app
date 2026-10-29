# Vendors

## Sub-features

Vendor detail reads named contacts through `vendor-directory.v2`. List reads retain v1. Office evidence, research status, and recorded territory remain separate.

## How to get to it (user POV)

Open Vendors. Select a vendor row. Read Contacts & offices in the record dialog. Close or press Escape to return focus to the row.

## Driving it with Playwright

Run `npx playwright test --project=fixtures tests/fixtures/vendor-people.spec.mjs --trace=on --output=.e2e/verify-fixtures`. The synthetic adapter supplies verified, needs-review, and unknown offices with missing contact channels. Inspect retained screenshots at desktop and phone widths in both themes.

## Gotchas

The v2 contract does not establish market membership or service coverage. A person without email or phone remains visible. Unknown offices remain unknown. Research status describes a recorded finding, not a queued enrichment job. These fixture tests do not verify staging or live records.
