# Home inbox

## Sub-features

Actor-scoped inbox, current-card links, Done and unseen badges, collapsed Working, Snoozed and Settled shelves, bulk per-item receipts, manual same-key retry, Undo, offline refusal, keyboard movement and phone swipe.

## How to get to it (user POV)

Open `/home` or `/`. Open a title to visit `/home/card/:item_id`. Expand a shelf to reach retained work. Select up to 100 cards for bulk actions. Swipe right for Settle, Un-settle or Wake; left for Snooze.

## Driving it with Playwright

`test/home-inbox-browser.test.mjs` drives signed-in synthetic MCP responses against `dist/site`. `tests/fixtures/home-brief.spec.mjs` covers populated, empty, loading and unavailable states in both themes and viewports. The phone performance scenarios wait for useful rows and check one bounded snapshot read.

## Gotchas

Build first. Local fixture changes are in-memory only. Live staging needs the deployed `home-inbox.v1` contract from carr-system PR #2801 and provisioned staging authentication. A read refusal is an error. No change is canonical until confirmed for that item. Retry keeps the exact original key and arguments; nothing silently replays on reconnect. Dismiss and refresh before making a new request after conflict. Contact detail and canonical task detail still need follow-up pages. The former Home dashboard widgets no longer mount.
