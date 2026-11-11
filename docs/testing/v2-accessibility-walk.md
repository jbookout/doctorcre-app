# V2 accessibility walk transitions

The [statechart](v2-accessibility-walk.mmd) models the ordered diagnostic walk in
`scripts/v2-accessibility-walk.ts`. Each observation awaits rendering, inspects
targets, and captures evidence. At 390 CSS px, repeated and reverse scans must
agree before that observation is accepted. The walk returns nine observations.
The absolute target contract validates the returned phone observations separately.

The following tests exercise the walk through its public entry point.
`Walk transition coverage` cases live in `test/v2-accessibility-walk.browser.ts`.
`V2 phone targets` lives in `test/v2-phone-accessibility.browser.ts` and builds
current application source at 390 and 1440 in both themes.

| Transition | Test name |
| --- | --- |
| Initial state to ready | Walk transition coverage: standalone |
| Ready to Home | Walk transition coverage: standalone |
| Home to Deals board | Walk transition coverage: standalone |
| Deals board to Deal | Walk transition coverage: standalone |
| Deal to Tours library | Walk transition coverage: standalone |
| Tours library to standalone Tour | Walk transition coverage: standalone |
| Tours library to embedded Tour | Walk transition coverage: embedded |
| Embedded Tour to refused inspection | Walk transition coverage: unavailable frame |
| Standalone Tour to cheat sheet | Walk transition coverage: standalone |
| Embedded Tour to cheat sheet | Walk transition coverage: embedded |
| Cheat sheet to Vendors | Walk transition coverage: standalone |
| Vendors to Suggested with closed disclosure | Walk transition coverage: standalone |
| Vendors to Suggested with open disclosure | Walk transition coverage: already open disclosures |
| Suggested to next page | Walk transition coverage: pagination |
| Suggested to refused inspection after 20 pages | Walk transition coverage: incomplete pagination |
| Suggested to recorded Suggested after the final page | Walk transition coverage: pagination |
| Recorded Suggested to Research | Walk transition coverage: pagination |
| Research to Relationships | Walk transition coverage: standalone |
| Relationships to Leads | Walk transition coverage: standalone |
| Leads to nine returned observations | Walk transition coverage: standalone |
| Required surface unavailable to refused inspection | Walk transition coverage: unavailable surface |
| Repeat and reverse inspection before accepting phone evidence | V2 phone targets have zero undersized or covered controls in both themes |
| Already open cheat sheet stays visible | Walk transition coverage: already open disclosures |

The focused tests use real Chromium documents and the real inspector. They use
synthetic route responses. Pagination replaces only the sentinel's scroll method
to append a real rendered vendor row, so the walk's real wait and 20-page bound
run deterministically. The unavailable-frame case returns null from a real
iframe handle's frame lookup. It tests refusal after losing the frame, not the
browser race that can cause that loss. The unavailable-surface case exercises the
real readiness timeout. These fixtures test the diagnostic driver. The source
walk tests the product and repeat/order invariance.

The chart synchronizes workflow steps with a second region that records each of
nine observations and a third region that records incomplete discovery. The two
never rules compile into separate checked TLC invariants. `CompletionRequiresNine`
rejects completion while fewer than nine observations are recorded.
`IncompleteDiscoveryRefusesCompletion` rejects completion after discovery fails.
The progress region records Home, Deals board, Deal, Tours library, Tour and cheat
sheet, Vendors Suggested, Vendors Research, Relationships, and Leads in that order.
Its synchronized transitions use the same tests listed above. The failure region
uses the unavailable surface, unavailable frame, and incomplete pagination tests.

The observation actions correspond to `inspect` and its awaited `capture` in
`scripts/v2-accessibility-walk.ts`. The refusal actions correspond to its readiness
wait, frame check, and pagination bound. Inspecting a surface includes discovery,
repeat and reverse checks, and capture before recording the result. The model
abstracts each successful navigation and inspection into one action. It leaves
out arbitrary page failures, Chromium internals, and DOM mutation schedules.
Runtime browser tests cover those concrete inspection paths separately.

To regenerate the model, copy the chart into a fresh scratch directory and run
`TLA2TOOLS=/path/to/tla2tools.jar JAVA=/path/to/java node /Users/booko/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/statechart/scripts/statechart.mjs from-chart /path/to/scratch/walk.mmd --module Walk --png`.
The generated `Walk.cfg` checks `TypeOK` and both semantic invariants independently.
The real chart passes. Adding `Ready --> Complete: finish without observing any surface`
breaks `CompletionRequiresNine` in one step. Adding `Incomplete --> Complete: finish after refusal`
breaks `IncompleteDiscoveryRefusesCompletion`. These mutation edges describe forbidden
model behavior, not observed shortcuts in the runtime walk.
