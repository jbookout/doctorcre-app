# Deal alerts

Home selects overdue local deals from Calendar & tasks. Home and Board render stored action items with short headings and numbered titles. Board item deadlines can differ from Home's agenda membership.

## Sub-features

`alerts-home-card`, `alerts-deal-card`, `alerts-deal-open`, `alerts-item-open`, `alerts-item-instruction`, and `alerts-item-complete`.

## How to get to it (user POV)

Open Home or Local Deals. Select a deal heading to open its room. Select an item title to open that item's sheet. Tell Dr. CRE records an instruction; Mark done completes only the selected item.

## Driving it with Playwright

Use `test/deal-items-browser.test.mjs`, `test/deal-item-sheet.test.mjs`, `test/deal-items-client.test.mjs`, `test/deal-attention-browser.test.mjs`, and `test/home-dashboard-browser.test.mjs`.

- Require `#dealFlags .home-flag h3 a`, save its href, and open the exact deal room. Compare the selected deal ID with the loaded record.
- On Board, choose `[data-deal-item]`. Require the matching item heading, dated bullets, Tell Dr. CRE input, and Mark done control in `.deal-item-sheet`.
- Save an instruction and require its confirmed receipt. A lost response keeps the original request and offers Check outcome. It must not claim the requested work executed.
- Complete one item, then require its siblings to remain. Closing the sheet returns focus to the item trigger or its deal heading.
- Run at phone and desktop widths. Existing tests retain synthetic card and sheet captures under `out/test-artifacts/deal-items`.

## Gotchas

Stored item UUIDs support item commands. The separate phase checklist derives milestones and has no item-completion command. Keep both views distinct.

Board cards show the earliest open next action, or the recorded next step, and the latest available activity. Structured items remain under Still needed. A deal with no next step or activity says No next step set; open the deal to add one. Empty Home attention cannot prove item opening. Use the existing dated synthetic fixtures. Local writes do not prove staging authentication, producer deployment, production backfill, or remote persistence.
