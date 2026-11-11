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
| Suggested to Research after the final page | Walk transition coverage: pagination |
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

The chart describes observable workflow control flow. It does not model arbitrary
page failures, Chromium internals, or all DOM mutation schedules. No formal
verification claim follows from the chart.
