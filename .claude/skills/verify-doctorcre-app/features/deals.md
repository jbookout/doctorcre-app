# Deals

Local Deals lets a partner review Board or List, open a deal room and return to the same record.

## Sub-features

`deals-board-open`, `deals-views`, `deals-list-open`, `deals-deep-link`, `deals-home-open`, `deals-reopen`, `deals-requirement-preview`.

## How to get to it (user POV)

Choose Local Deals in Primary navigation or open `/deals`. Open a visible deal heading from Board or List, a Home flag, or `/deals?deal=d14` for the local Demo Surgical Practice fixture.

## Driving it with Playwright

Existing coverage: `test/local-deals-browser.test.mjs`, `test/dealroom-acceptance-browser.test.mjs` and the Home link tests. The fixture Playwright project also runs the parked-deal journey in `tests/fixtures/staging-controls.spec.mjs`.

- Require a visible `.card-open`. Save its title, click, and require visible `#recordPanel`, matching `#panelTitle` and visible `#detailUpdateForm`.
- Use Close deal, require the panel hidden, then reopen that same heading and compare the title.
- A missing or blank next step shows Next step missing on active Board and List cards and in the deal room. Refresh removes the gap when a recorded step arrives and restores it when cleared. Parked and closed deal rooms do not show the gap. `test/local-deals-browser.test.mjs` covers both widths and the existing string and text-object values.
- Choose List; require `#listView[aria-pressed="true"]`. Open a **visible** `.card-open` in that view and compare the room title. Return to Board and require `#boardView[aria-pressed="true"]`.
- Open the local direct URL above and compare Demo Surgical Practice. Separately follow the Home flag and navigation link; Board opening does not cover either path.

- Open Draft requirement email in a deal. Enter approved requirements, generate and edit the subject and message, then copy the draft. `test/pipeline-interruption-browser.test.mjs` covers anonymous generation, copy failure, discard, record isolation and identity revocation. Drafts remain only while the page is open.

## Gotchas

Use actual synthetic staging IDs when verifying staging. Deep-link close changes the URL, so check URL and dialog independently. Manual read-only inspection must not submit Update, change Phase or Owner, Park, or Mark inactive.
