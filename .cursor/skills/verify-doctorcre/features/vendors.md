# Vendor directory

Owner filter and reset change the results; the selected vendor dialog reveals its original introduction entry.

```json
{
  "id": "vendors",
  "title": "Vendor directory",
  "entryPoints": [
    {
      "id": "bookmark",
      "route": "/vendors",
      "handles": [
        "#resultSummary",
        "[data-owner=\"dell\"]",
        "#resetFilters",
        ".record-row",
        "#recordPanel",
        "[data-details-key=\"intro-demo-intro\"]"
      ]
    },
    {
      "id": "shared-navigation",
      "route": "/vendors",
      "handles": [
        "[data-app-nav-item][aria-label=\"Vendors\"]"
      ]
    }
  ],
  "subFeatures": [
    "vendors-owner",
    "vendors-record"
  ],
  "userRoute": [
    "Owner. Choose Dell's owner filter, then `#resetFilters`; the bundled directory narrows from 62 to 31 entries and returns to 62.",
    "Record. Choose the first `.record-row`; `#recordPanel` opens as a dialog.",
    "Original. Expand the introduction summary; the original synthetic introduction entry is visible. Escape returns to Results."
  ],
  "observableEndState": "Owner filter and reset change the results; the selected vendor dialog reveals its original introduction entry.",
  "storedValues": [],
  "gotchas": [
    "The CLI reuses the repository's synthetic directory fixture at the HTTP seam.",
    "Filters can change the URL; assert the rendered results as well as the selected control.",
    "This recipe performs no contact, introduction send, or record write."
  ]
}
```

## Sub-features

- `vendors-owner` — filter the directory by owner and reset it.
- `vendors-record` — open the full vendor record and original introduction evidence.

## How to get to it (user POV)

- Open `/vendors` as a bookmark.
- Choose `Vendors` in the shared navigation.

## Driving it with verify-doctorcre

Preconditions:

- Launch an owned local fixture instance and require `doctor` to pass.
- Use the CLI's fresh synthetic browser state for this recipe.

Run `.cursor/skills/verify-doctorcre/verify-doctorcre.mjs drive vendors --run "$VERIFY_RUN"`.
It performs these user actions with Playwright and records each result:

- **Owner.** Choose Dell's owner filter, then `#resetFilters`; the bundled directory narrows from 62 to 31 entries and returns to 62.
- **Record.** Choose the first `.record-row`; `#recordPanel` opens as a dialog.
- **Original.** Expand the introduction summary; the original synthetic introduction entry is visible. Escape returns to Results.
- **Proof.** Run `.cursor/skills/verify-doctorcre/verify-doctorcre.mjs evidence --run "$VERIFY_RUN"`; screenshots, ARIA snapshots, action/result records, and a trace identify this feature and its exercised entry points.

## Gotchas

- The CLI reuses the repository's synthetic directory fixture at the HTTP seam.
- Filters can change the URL; assert the rendered results as well as the selected control.
- This recipe performs no contact, introduction send, or record write.
