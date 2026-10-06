# Progress board navigation

A directory tile opens a dedicated board tab with published tasks and no directory; a legacy bookmark resolves to that page.

```json
{
  "id": "progress-navigation",
  "title": "Progress board navigation",
  "entryPoints": [
    {
      "id": "directory-tile",
      "route": "/control-room/progress",
      "handles": [
        "[data-board-id=\"carr-v5\"]",
        "#board-title",
        "#board-stages",
        ".directory-panel"
      ]
    },
    {
      "id": "legacy-bookmark",
      "route": "/control-room/progress?board=carr-v5",
      "handles": [
        "#board-stages"
      ]
    }
  ],
  "subFeatures": [
    "progress-tile",
    "progress-legacy"
  ],
  "userRoute": [
    "Tile. Open `/control-room/progress`, choose `[data-board-id=\"carr-v5\"]`, and observe the newly opened tab.",
    "Board. The tab reaches `/control-room/progress/board/carr-v5`, displays the published task in `#board-stages`, and hides `.directory-panel`.",
    "Legacy. Open `/control-room/progress?board=carr-v5`; the same dedicated board page opens."
  ],
  "observableEndState": "A directory tile opens a dedicated board tab with published tasks and no directory; a legacy bookmark resolves to that page.",
  "storedValues": [],
  "gotchas": [
    "Progress uses the existing CARR MCP seam; the CLI supplies synthetic published board responses.",
    "The same tile oracle must run on both historical revisions; never weaken it for the pre-fix app.",
    "The historical failing run must remain failed; `evidence` validates its files without declaring the behavior passed."
  ]
}
```

## Sub-features

- `progress-tile` — open a board tile in its own page.
- `progress-legacy` — resolve a legacy board bookmark to its dedicated page.

## How to get to it (user POV)

- Open `/control-room/progress` as a bookmark.
- Choose a board tile in the directory.
- Open the legacy `/control-room/progress?board=carr-v5` bookmark.

## Driving it with verify-doctorcre

Preconditions:

- Launch an owned local fixture instance and require `doctor` to pass.
- Use the CLI's fresh synthetic browser state for this recipe.

Run `.cursor/skills/verify-doctorcre/verify-doctorcre.mjs drive progress-navigation --run "$VERIFY_RUN"`.
It performs these user actions with Playwright and records each result:

- **Tile.** Open `/control-room/progress`, choose `[data-board-id="carr-v5"]`, and observe the newly opened tab.
- **Board.** The tab reaches `/control-room/progress/board/carr-v5`, displays the published task in `#board-stages`, and hides `.directory-panel`.
- **Legacy.** Open `/control-room/progress?board=carr-v5`; the same dedicated board page opens.
- **Proof.** Run `.cursor/skills/verify-doctorcre/verify-doctorcre.mjs evidence --run "$VERIFY_RUN"`; screenshots, ARIA snapshots, action/result records, and a trace identify this feature and its exercised entry points.

## Gotchas

- Progress uses the existing CARR MCP seam; the CLI supplies synthetic published board responses.
- The same tile oracle must run on both historical revisions; never weaken it for the pre-fix app.
- The historical failing run must remain failed; `evidence` validates its files without declaring the behavior passed.
