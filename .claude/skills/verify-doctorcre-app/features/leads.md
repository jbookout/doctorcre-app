# Leads

Leads lets a partner search the loaded board, filter by owner or stage and inspect a lead without claiming it or changing its stage.

## Sub-features

- `leads-search` narrows and clears the board.
- `leads-filter` selects owner and stage filters.
- `leads-detail` opens and closes the selected lead.

## How to get to it (user POV)

- Choose `Leads` in `Primary navigation`, or open `/leads`.
- Use `Search leads`, the owner and stage filters, or a lead card.

## Driving it with Playwright

Preconditions:

- Doctor passes and `.lead-card` contains a visible lead. If plain local fixtures lack the board data, report the missing precondition; existing lead tests use the synthetic fixture in `test/leads-workspace-fixture.mjs` at the HTTP client seam.

- **Entry.** Run `await page.goto(new URL('/leads', origin).href)` and require `page.locator('.lead-card').first()` visible. Repeat through the `Leads` link inside `Primary navigation` when navigation changed.
- **Search.** Run `await page.getByRole('searchbox', { name: 'Search leads', exact: true }).fill('V2 no matching lead 35f9009c')`. Require zero `.lead-card` elements. Fill the searchbox with `''`, require a visible card and hidden `#leadBoardError`.
- **Filters.** Run `await page.locator('#ownerFilter').selectOption('joe')`, require value `joe`, then clear with `selectOption('')`. Select the first nonempty `#stageFilter` option, require nonempty `#filterSummary`, then clear the filter and require visible cards.
- **Details.** Capture the chosen `.lead-card` title, click that card, require visible `#leadDetail` and matching `#detailTitle`. Capture the dialog. Run `await page.getByRole('button', { name: 'Close lead details', exact: true }).click()` and require the dialog hidden.

## Gotchas

- Live Leads may need a synthetic staging record. A loaded shell alone does not prove search or details.
- Do not Claim, activate, or submit a stage change during this read-only recipe.
- Empty owner or stage results are not a substitute for restoring the full board after clearing filters.
