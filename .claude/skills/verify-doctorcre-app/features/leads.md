# Leads

Leads lets a partner search the board, filter by owner, market or stage, and inspect a lead.

## Sub-features

`leads-search`, `leads-filter`, `leads-detail`, bounded stage lanes.

## How to get to it (user POV)

Choose Leads in Primary navigation or open `/leads`. Use Search leads, Owner, Market, Board stage, or a visible lead's detail control.

## Driving it with Playwright

Existing coverage: `tests/fixtures/staging-leads.spec.mjs` runs the staging assertions through `test/leads-browser-fixture.mjs` and its synthetic HTTP adapter. The Node suite also runs `test/leads-workspace.test.mjs` and the Leads browser tests.

- Require visible `#leadBoard .lead-card` and hidden `#leadBoardError` before starting.
- Search for a unique nonmatching string; require zero board cards. Clear Search leads and require the board restored. Scope assertions to `#leadBoard`; the Hottest leads section has separate cards.
- Choose an owner present in `#ownerFilter`, then clear it with the empty option. Choose a populated Board stage in `#stageFilter`, require matching visible cards and `#filterSummary`, then clear it. Never assume staging has owner `joe`.
- Each stage starts with at most five cards. Choose Show all in its heading to scroll the full lane beneath the heading and Collapse control. Counts and search include every matching lead.
- Use the selected card's `.lead-open` button. Compare `#detailTitle` to that lead's title and require visible `#leadDetail`. Use Close lead details and require it hidden.

## Gotchas

The plain static preview does not supply the Leads workspace API. Use the existing routed fixture tests for populated local coverage. Claim and stage changes write records; the automated fixtures isolate those writes. Avoid those actions during manual read-only inspection.
