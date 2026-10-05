# Home attention

Just Me shows two flags; Team View shows four; the attention link opens Demo Dental North's record.

```json
{
  "id": "home",
  "title": "Home attention",
  "entryPoints": [
    {
      "id": "bookmark",
      "route": "/",
      "handles": [
        "#dealFlags .home-flag",
        "button[data-scope=\"mine\"]",
        "button[data-scope=\"team\"]"
      ]
    },
    {
      "id": "shared-navigation",
      "route": "/",
      "handles": [
        "[data-app-nav-item][aria-label=\"Home\"]"
      ]
    }
  ],
  "subFeatures": [
    "home-scope",
    "home-deal"
  ],
  "userRoute": [
    "Scope. Choose `Just Me`, then `Team View`; the synthetic flag list changes from two to four deals.",
    "Open. Choose the first flag for `Demo Dental North`; `/deals?deal=d01` opens its full record with `#panelTitle` and `#detailNextForm`."
  ],
  "observableEndState": "Just Me shows two flags; Team View shows four; the attention link opens Demo Dental North's record.",
  "storedValues": [],
  "gotchas": [
    "The counts belong to the bundled synthetic fixture, not the live book.",
    "Home's flag opens a deal page; check the requested record identity after navigation."
  ]
}
```

## Sub-features

- `home-scope` — filter flagged deals between Just Me and Team View.
- `home-deal` — open the exact deal from its attention flag.

## How to get to it (user POV)

- Open `/` as a bookmark.
- Choose `Home` in the shared navigation.

## Driving it with verify-doctorcre

Preconditions:

- Launch an owned local fixture instance and require `doctor` to pass.
- Use the CLI's fresh synthetic browser state for this recipe.

Run `.cursor/skills/verify-doctorcre/verify-doctorcre.mjs drive home --run "$VERIFY_RUN"`.
It performs these user actions with Playwright and records each result:

- **Scope.** Choose `Just Me`, then `Team View`; the synthetic flag list changes from two to four deals.
- **Open.** Choose the first flag for `Demo Dental North`; `/deals?deal=d01` opens its full record with `#panelTitle` and `#detailNextForm`.
- **Proof.** Run `.cursor/skills/verify-doctorcre/verify-doctorcre.mjs evidence --run "$VERIFY_RUN"`; screenshots, ARIA snapshots, action/result records, and a trace identify this feature and its exercised entry points.

## Gotchas

- The counts belong to the bundled synthetic fixture, not the live book.
- Home's flag opens a deal page; check the requested record identity after navigation.
