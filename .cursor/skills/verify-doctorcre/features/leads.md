# Leads workspace

Stage and market filters narrow the board; selected lead details show original evidence; territory remains visible.

```json
{
  "id": "leads",
  "title": "Leads workspace",
  "entryPoints": [
    {
      "id": "bookmark",
      "route": "/leads",
      "handles": [
        "#leadBoard",
        "#stageFilter",
        "#leadDetail",
        "#territoryMap"
      ]
    },
    {
      "id": "shared-navigation",
      "route": "/leads",
      "handles": [
        "[data-app-nav-item][aria-label=\"Leads\"]"
      ]
    }
  ],
  "subFeatures": [
    "leads-filter",
    "leads-detail",
    "leads-territory"
  ],
  "userRoute": [
    "Open the workspace sidebar; choose Qualified in the Stage filter, then restore All stages.",
    "Choose Pensacola, FL from market counts; the board narrows to twelve Pensacola cards and the map remains available.",
    "Choose a lead card; expand its original evidence and close the details with Escape."
  ],
  "observableEndState": "Stage and market filters narrow the board; selected lead details show original evidence; territory remains visible.",
  "storedValues": [],
  "gotchas": [
    "Leads uses the CARR MCP seam even on localhost; the CLI supplies the existing synthetic workspace fixture there.",
    "The workspace sidebar starts closed on board pages; open it before using filters.",
    "No claim, outreach, stage mutation, or partner record is exercised."
  ]
}
```

## Sub-features

- `leads-filter` — filter the lead board by stage and market.
- `leads-detail` — open and close a lead's original evidence.
- `leads-territory` — display the market map and counts.

## How to get to it (user POV)

- Open `/leads` as a bookmark.
- Choose `Leads` in the shared navigation.

## Driving it with verify-doctorcre

Preconditions:

- Launch an owned local fixture instance and require `doctor` to pass.
- Use the CLI's fresh synthetic browser state for this recipe.

Run `.cursor/skills/verify-doctorcre/verify-doctorcre.mjs drive leads --run "$VERIFY_RUN"`.
It performs these user actions with Playwright and records each result:

- **Filter.** Open the workspace sidebar, choose `Qualified` in `#stageFilter`, then restore `All stages`; the board narrows to one card and restores fourteen cards. Choose `Pensacola, FL` from the market counts; twelve cards remain, excluding Gulf Breeze and Mobile.
- **Detail.** Choose a lead card; `#leadDetail` shows the selected title and original synthetic evidence. Close with Escape.
- **Territory.** Observe `#territoryMap` and `#marketCounts`; the map and matching market counts remain present.
- **Proof.** Run `.cursor/skills/verify-doctorcre/verify-doctorcre.mjs evidence --run "$VERIFY_RUN"`; screenshots, ARIA snapshots, action/result records, and a trace identify this feature and its exercised entry points.

## Gotchas

- Leads uses the CARR MCP seam even on localhost; the CLI supplies the existing synthetic workspace fixture there.
- The workspace sidebar starts closed on board pages; open it before using filters.
- No claim, outreach, stage mutation, or partner record is exercised.
