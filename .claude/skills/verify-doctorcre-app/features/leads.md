# Leads

Leads lets a partner search the board, filter by owner, market, specialty or stage, and inspect a lead.

## Sub-features

`leads-search`, `leads-filter`, `leads-detail`, bounded stage lanes.

## How to get to it (user POV)

Choose Leads in Primary navigation or open `/leads`. Use Search leads, Owner, Market, Specialty, Board stage, or a visible lead's detail control.

## Driving it with Playwright

Existing coverage: `tests/fixtures/staging-leads.spec.mjs` runs the staging assertions through `test/leads-browser-fixture.mjs` and its synthetic HTTP adapter. The Node suite also runs `test/leads-workspace.test.mjs` and the Leads browser tests.

- Require visible `#leadBoard .lead-card` and hidden `#leadBoardError` before starting.
- Search for a unique nonmatching string; require zero board cards. Clear Search leads and require the board restored. Scope assertions to `#leadBoard`; the board is the only ranked lead list.
- Choose an owner present in `#ownerFilter`, then clear it with the empty option. Choose a populated Board stage in `#stageFilter`, require matching visible cards and `#filterSummary`, then clear it. Never assume staging has owner `joe`.
- Choose Show territory and require the default frame to cover Mobile, Tallahassee and Dothan. Filters and refresh keep the same camera and canvas.
- Choose a Specialty and require the board, map member list and matching count to narrow together. Clear it with All specialties. A refreshed snapshot with no matching specialty keeps the filter and shows zero matches.
- The Territory link beside the page title jumps to the market map and chips. Show territory loads the map on demand.
- Each stage starts with at most five cards. Choose Show all in its heading to scroll the full lane beneath the heading and Collapse control. Counts and search include every matching lead.
- Hover or focus a map marker. Require a readable preview with current count, place names, up to three lead titles and **Market area only**. Escape dismisses without moving focus. Filtering refreshes or removes the preview.
- Activate a multi-lead city group on the map, or a terminal cluster at zoom 11. Require the **Leads in this place** chooser and **Market area only** label. Open each member with mouse and Enter, compare the detail title and selected card, then close and require the same member focus and unchanged camera. Escape closes the chooser and returns focus to its marker. Filters remove excluded members. No city group offers address navigation.
- Use the selected card's `.lead-open` button. Compare `#detailTitle` to that lead's title and require visible `#leadDetail`. Use Close lead details and require it hidden.

## Gotchas

The plain static preview does not supply the Leads workspace API. Use the existing routed fixture tests for populated local coverage. Claim and stage changes write records; the automated fixtures isolate those writes. Avoid those actions during manual read-only inspection.

Reasons to reach out loads the pinned `practice-origination.v1` read independently of the board. Each existing work card shows registration or publication evidence with a public CMS source. Exact client matches open `/clients?record=...`; ambiguous matches say Needs review and offer only the source. Coverage distinguishes covered, blocked updates and not yet covered sources. More reasons pages with the server cursor. Home loads reasons when its secondary panels enter view, shows at most three research reasons and links to this section. `test/practice-origination.test.mjs` covers the client reads, synthetic routes, coverage, rendered copy, failure recovery and session retirement. `test/contact-reasons-browser.test.mjs` drives both entry points at 390px and 1440px in light and dark, with synthetic captures under `out/test-artifacts/contact-reasons/`. These checks do not prove signed-in staging or live source imports.
