# Tour planning drafts

Client prefill and Undo work; date and search requirements survive reload; the selected synthetic tour opens.

```json
{
  "id": "tours",
  "title": "Tour planning drafts",
  "entryPoints": [
    {
      "id": "bookmark",
      "route": "/tours",
      "handles": [
        "#plan-client",
        "#plan-name",
        "#plan-area",
        "#plan-date",
        "#space-requirements",
        "#save-search",
        "#tour-dialog"
      ]
    },
    {
      "id": "shared-navigation",
      "route": "/tours",
      "handles": [
        "[data-app-nav-item][aria-label=\"Tours\"]"
      ]
    }
  ],
  "subFeatures": [
    "tours-prefill",
    "tours-undo",
    "tours-draft",
    "tours-library"
  ],
  "userRoute": [
    "Prefill. Choose `Demo Harbor Practice` in `#plan-client`; `#plan-name` contains Demo Harbor and `#plan-area` reads `Pensacola, FL`.",
    "Undo. Edit `#plan-area`, then choose `Undo tour edit`; the prefilled area returns.",
    "Draft. Enter a date and space requirements, choose `#save-search`, then reload; the saved search message and retained field values prove the local draft.",
    "Library. Choose the upcoming `Demo Gulf Coast Tour`; `#detail-title` identifies the selected tour. Escape closes `#tour-dialog`."
  ],
  "observableEndState": "Client prefill and Undo work; date and search requirements survive reload; the selected synthetic tour opens.",
  "storedValues": [
    "tab-local tour date",
    "tab-local search requirements"
  ],
  "gotchas": [
    "Draft persistence is in this isolated browser tab, not a saved CARR tour.",
    "The CLI supplies synthetic client and tour-library responses at the existing HTTP seam.",
    "Live tour creation, geocoding, external maps, voice recording, and outbound handoff require separate proofs."
  ]
}
```

## Sub-features

- `tours-prefill` — select a client and prefill the tour plan.
- `tours-undo` — restore an edited field.
- `tours-draft` — save a search and retain local draft fields across reload.
- `tours-library` — open and close an upcoming tour.

## How to get to it (user POV)

- Open `/tours` as a bookmark.
- Choose `Tours` in the shared navigation.

## Driving it with verify-doctorcre

Preconditions:

- Launch an owned local fixture instance and require `doctor` to pass.
- Use the CLI's fresh synthetic browser state for this recipe.

Run `.cursor/skills/verify-doctorcre/verify-doctorcre.mjs drive tours --run "$VERIFY_RUN"`.
It performs these user actions with Playwright and records each result:

- **Prefill.** Choose `Demo Harbor Practice` in `#plan-client`; `#plan-name` contains Demo Harbor and `#plan-area` reads `Pensacola, FL`.
- **Undo.** Edit `#plan-area`, then choose `Undo tour edit`; the prefilled area returns.
- **Draft.** Enter a date and space requirements, choose `#save-search`, then reload; the saved search message and retained field values prove the local draft.
- **Library.** Choose the upcoming `Demo Gulf Coast Tour`; `#detail-title` identifies the selected tour. Escape closes `#tour-dialog`.
- **Proof.** Run `.cursor/skills/verify-doctorcre/verify-doctorcre.mjs evidence --run "$VERIFY_RUN"`; screenshots, ARIA snapshots, action/result records, and a trace identify this feature and its exercised entry points.

## Gotchas

- Draft persistence is in this isolated browser tab, not a saved CARR tour.
- The CLI supplies synthetic client and tour-library responses at the existing HTTP seam.
- Live tour creation, geocoding, external maps, voice recording, and outbound handoff require separate proofs.
