# Task destinations

The switcher maps each producer `item_id` through `recordRoutes.card`.
Home owns the card and the current snapshot. The model separates the selected
task from the screen. It checks that source types cannot open each other's card.
It leaves out transport, filtering, authorization, recents and arbitrary UUIDs.
The browser tests cover real producer IDs and the live-client and Home parsers.

Regenerate with the installed pstack statechart skill. Set `TLA2TOOLS` to the
TLC jar and `JAVA` to Java 11 or later, then run from a scratch copy of this folder.

```sh
node /Users/booko/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/statechart/scripts/statechart.mjs from-spec TaskDestinations.tla --map TaskDestinations.map.mjs --out result --png
```

The initial chart-to-spec check passed. The readable model has seven states,
six transitions and no rule violations, as recorded in `summary.json`.
The model is an acceptance model, not a formal refinement proof of the code.

Every transition has browser coverage in
`test/quick-switcher-kind-filter-browser.test.mjs`.

| Transition | Test |
| --- | --- |
| Results to next-action route by pointer | tasks sharing a deal open their own canonical cards with pointer and Enter |
| Results to call-follow-up route by Enter | producer task identities and exact Home cards |
| Next-action route to its Home card | producer task identities and exact Home cards |
| Call-follow-up route to its Home card | producer task identities and exact Home cards |
| Next-action route to unavailable disclosure | producer task identities and outside-snapshot disclosure |
| Call-follow-up route to unavailable disclosure | producer task identities and outside-snapshot disclosure |

Each test runs at 390 and 1440 pixels in light and dark themes. The producer
fixture deliberately gives both source types the same table-local UUID.
The tests assert the exact route, rendered identity and distinct recent IDs.
