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

- Updates previews the newest recorded entry. Expand Recorded updates to verify descending instants with undated entries last. `test/deal-timeline-browser.test.mjs` checks 390px and 1440px in both themes and writes synthetic captures under `out/test-artifacts/newest-updates/`. `test/deal-timeline.test.mjs` covers offsets, sub-millisecond timestamps, documents and missing dates.

- Vendor assignments retain role, company and contact name. Expand Contact details to read the recorded email and phone without opening the deal or changing its phase. A contact without either channel has no disclosure. `test/deal-vendors-browser.test.mjs` checks click and keyboard operation, escaped channels, Board, List, parked and archived cards, and the deal room at phone and desktop widths. Synthetic captures remain under `out/test-artifacts/deal-vendors/`.

- Open Draft requirement email in a deal. Enter approved requirements, generate and edit the subject and message, then copy the draft. `test/pipeline-interruption-browser.test.mjs` covers anonymous generation, copy failure, discard, record isolation and identity revocation. Drafts remain only while the page is open.

- Call mode reviews a discussed deal's next step separately from its note. A pending matched proposal offers Confirm next step and Skip next step. A missing date warns that confirmation clears the current date. Settled or unmatched proposals stay visible without decision controls. `test/dealroom-call-mode.test.mjs` drives phone confirmation and desktop skipping with the real dialog, plus stale refusal and retained-request recovery. Synthetic captures remain under `out/test-artifacts/call-next-step/`.

## Gotchas

Use actual synthetic staging IDs when verifying staging. Deep-link close changes the URL, so check URL and dialog independently. Manual read-only inspection must not submit Update, change Phase or Owner, Park, or Mark inactive.
