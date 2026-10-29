# Progress board

## Sub-features

Standalone stage boards offer Active, Completed, Needs a hand, Queue and History.
Each lane shows up to 20 cards with its total and Show all/Show fewer controls.
View changes retain lane expansion, scroll and the focused card.

## How to get to it (user POV)

Open Progress, choose a published stage board, then choose a work view.
Use Find a board in the bounded directory to select another project.
Expand Queue, focus a card near the end, switch to Active, then return to Queue.
Verify the focused card and scroll return. Collapse the lane with Show fewer.

## Driving it with Playwright

Run `node --test test/progress-board-directory-layout.test.mjs` for 166 directory
entries and 100 queued cards at desktop and phone widths. Run
`node --test test/progress-board-page-browser.test.mjs` for canonical routes
with the actual app shell, view membership, lane controls and focus restoration.
The synthetic adapters are in those existing tests. Retain their screenshots
under `test-artifacts/progress-views` and `test-artifacts/directory` and inspect
them before claiming visual verification.

## Gotchas

Hierarchy, work-queue, Orchestrator and embedded boards keep their existing
navigation. Status membership uses the current producer-derived stage and
health. These tests do not prove production delivery, authoritative work
versions or staging access. Snapshot generation is not a product version.
