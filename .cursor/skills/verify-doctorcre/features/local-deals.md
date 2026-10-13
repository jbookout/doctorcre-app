# Local Deals board

The card moves to Legal after confirmation and its detail agrees; Home attention opens its selected deal.

```json
{
  "id": "local-deals",
  "title": "Local Deals board",
  "entryPoints": [
    {
      "id": "bookmark",
      "route": "/deals",
      "handles": [
        ".kanban-column",
        "[data-id=\"d23\"]",
        "#completionDialog",
        "#completionConfirm",
        "#panelTitle"
      ]
    },
    {
      "id": "shared-navigation",
      "route": "/deals",
      "handles": [
        "[data-app-nav-item][aria-label=\"Local Deals\"]"
      ]
    },
    {
      "id": "home-attention",
      "route": "/",
      "handles": [
        "#dealFlags .home-flag",
        "#panelTitle"
      ]
    }
  ],
  "subFeatures": [
    "deals-board",
    "deals-move",
    "deals-attention"
  ],
  "userRoute": [
    "Board. Open Local Deals; the board renders its phase columns and synthetic cards.",
    "Move. Drag `Demo Specialty Clinic` deal card `d23` from Negotiation to Legal, then confirm in `#completionDialog`; the card appears in Legal and leaves Negotiation.",
    "Readback. Open the moved deal through its card; the detail record shows the Legal phase.",
    "Attention. Open Home and choose the Demo Specialty Clinic attention flag; its addressed deal record opens."
  ],
  "observableEndState": "The card moves to Legal after confirmation and its detail agrees; Home attention opens its selected deal.",
  "storedValues": [],
  "gotchas": [
    "The board fixture is in memory; a page reload starts the seed again. This recipe proves the session mutation, not durable CARR storage.",
    "A phase drag needs confirmation; a changed hover target alone is insufficient.",
    "The Home attention path is also covered by the Home recipe and recorded separately."
  ]
}
```

## Sub-features

- `deals-board` — display the fixture phase columns.
- `deals-move` — drag a deal, confirm its phase change, and read it back from its record.
- `deals-attention` — reach a selected deal from Home.

## How to get to it (user POV)

- Open `/deals` as a bookmark.
- Choose `Local Deals` in the shared navigation.
- Choose a deal flag on Home.

## Driving it with verify-doctorcre

Preconditions:

- Launch an owned local fixture instance and require `doctor` to pass.
- Use the CLI's fresh synthetic browser state for this recipe.

Run `.cursor/skills/verify-doctorcre/verify-doctorcre.mjs drive local-deals --run "$VERIFY_RUN"`.
It performs these user actions with Playwright and records each result:

- **Board.** Open Local Deals; the board renders its phase columns and synthetic cards.
- **Move.** Drag `Demo Specialty Clinic` deal card `d23` from Negotiation to Legal, then confirm in `#completionDialog`; the card appears in Legal and leaves Negotiation.
- **Readback.** Open the moved deal through its card; the detail record shows the Legal phase.
- **Attention.** Open Home and choose the Demo Specialty Clinic attention flag; its addressed deal record opens.
- **Proof.** Run `.cursor/skills/verify-doctorcre/verify-doctorcre.mjs evidence --run "$VERIFY_RUN"`; screenshots, ARIA snapshots, action/result records, and a trace identify this feature and its exercised entry points.

## Gotchas

- The board fixture is in memory; a page reload starts the seed again. This recipe proves the session mutation, not durable CARR storage.
- A phase drag needs confirmation; a changed hover target alone is insufficient.
- The Home attention path is also covered by the Home recipe and recorded separately.
