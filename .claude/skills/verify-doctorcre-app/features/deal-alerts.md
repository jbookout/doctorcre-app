# Deal alerts

Home flags overdue local next steps and links each flag to its deal room. The Board marks the same overdue deals.

## Sub-features

`alerts-home-card`, `alerts-deal-card`, `alerts-deal-open`. Numbered alert items and item-detail sheets are not implemented.

## How to get to it (user POV)

Open Home and inspect deal attention. Choose a flagged deal heading, then find the same deal on Local Deals.

## Driving it with Playwright

Existing coverage: `test/deal-attention-browser.test.mjs` compares Home and Board overdue counts in team and personal scopes. `test/home-dashboard-browser.test.mjs` checks the exact deal destination.

- Require `#dealFlags a.home-flag` with a `strong` deal heading and the current next-step or phase text. Save its title and `href`.
- Click the flag and require its exact `/deals?deal=...` destination and matching room title.
- Return to Board, find the same `.kanban-card` by its visible heading and require its `.attention-flag` overdue badge. Compare within the same owner scope.

## Gotchas

Current flags render next-step prose, not `Still needed:` lists. Do not assert a numbered checklist, item dialog or Tell Dr. CRE field that the app does not provide. An empty attention region cannot prove flag opening; use the existing dated synthetic test. Do not invent browser records to make a missing feature pass.
