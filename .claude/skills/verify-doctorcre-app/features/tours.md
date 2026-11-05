# Tours

## Sub-features

Tours is a cross-deal library. A deal-bound row opens the deal workspace Tours tab. Legacy unbound tours remain readable. Tour creation starts only inside a deal workspace. The workspace embeds the existing route editor, which owns shortlist, route, packet and retained-write recovery.

## How to get to it (user POV)

Open Deals, choose a deal board card, then Tours. Open an existing tour or choose Start a tour. Back to deal tours returns to the list. The browser URL stays under /deals and carries the selected tour. Old itinerary URLs for deal-bound tours redirect here. Public share packets keep their existing routes.

## Driving it with Playwright

Run node --test test/deal-tours.test.mjs test/deal-tours-browser.test.mjs test/tour-composer.test.mjs test/w6-planner.test.mjs test/w6-planner-browser.test.mjs. The browser fixture drives the board, Tours tab, shared editor, saving, creation, return links and old deep links at 390, 1024 and 1440 in light and dark. Screenshots remain under out/test-artifacts/deal-tours.

Run npx playwright test --project=fixtures tests/fixtures/tours-client-drafts.spec.mjs --trace=on for cross-deal library links and absence of standalone planning forms.

## Gotchas

The editor is a same-origin frame with its own document. Use frameLocator with the title Tour shortlist, route and packet. The parent URL owns the selection. The frame cannot create without a matching deal workspace parent. Editor responses and recovered requests still use the authenticated CARR contract. Retained requests preserve their original session and tour binding. Reconcile an unresolved request in its original workspace. These tests prove synthetic persistence only.
