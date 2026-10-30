# Tours

## Sub-features

The existing tour planner retains separate Client and Research drafts. Plan from search selects the exact subject, carries area and space type into planning, and includes every nonempty search constraint in packet review. Client-record refreshes leave existing drafts untouched and offer keep-or-use choices for differing client-sourced fields, including typed and empty values. Comparisons show before/after values and the local read time. A changed suggested tour name requires an explicit draft-name choice before packet review. These are tab-local drafts. No canonical search revision, listing shortlist, route creation, or packet compilation is claimed.

## How to get to it (user POV)

Open Tours. Enter search criteria under Search for space. Choose Plan from search. Review the plan and select Review packet draft. The Search draft section shows the same subject's size, budget basis, transaction, availability, parking, and requirements.

## Driving it with Playwright

Run `npx playwright test --project=fixtures tests/fixtures/tours-client-drafts.spec.mjs --trace=on`. The search-packet cases cover phone, tablet, and desktop in both themes. They check all ten fields, exact client isolation, cleared fields after reload, Research, and inert text. The client-record update cases use 390×844 and 1440×900 in both themes and capture name comparison, Plan updates and Search updates. Screenshots are written to the test output directory.

Run `node --test test/w6-planner.test.mjs` for mounted form behavior, unavailable client reads, invalid criteria, and repeated planning with private files retained.

## Gotchas

The search draft belongs to the exact client ID or Research. It is separate from deliberately edited itinerary facts. Reopen packet review to see newer criteria. Another client selected in Search never supplies fallback criteria for the plan. Client refresh reads existing records through the authenticated contract. No mailbox capture or licensed listing search runs in the browser.
