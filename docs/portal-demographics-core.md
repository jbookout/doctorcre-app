# Demographics core

Card: WR227.S12.J1

Size is medium. One injected React module owns growth, age, median income and
income-band presentation. S10 owns loading, validation, routing and bundling.
Base main is 28a1a144cc6659b83617a19f06f504332570fe38. The source contract is
DoctorCRE/carr-system 865fefee26fcbbe50a04c7515c5f3d3bc8913cd1, including the
standard-site design, market-study.v1 schema, synthetic package and parity probes.
Current main has no src/ui/portal directory or demographics implementation.

## System design

Architecture. DemographicsCore accepts already validated demographics data.
A structural core projection accepts S10's Demographics type without importing
its unmerged branch. Register only when data exists. Load
portal/demographics-core.css with the shell stylesheet, and render
`<DemographicsCore demographics={publication.demographics} />`.
No common router, loader, package validator or bundle is added here.

Capacity and scaling. Rendering is linear in package rows at current and 10x
package sizes. Large publications first increase DOM size. No repeated remote
reads or N+1 queries occur. Tests exercise a 10x synthetic geography set.
Load spread and storage. n/a, injected immutable data only.
Caching. No independent cache. Each render derives values from the current
publication and selections, so replacement cannot retain old publication data.
Availability and consistency. Absent data hides the module. Unmatched geography
rows and missing threshold counts display Unknown. No interpolation or zero fill.
Async, queues, circuit breakers, rate limits and write idempotency. n/a, no
external calls, writes or sends. Source anchors open on user activation.
DOM tests reject unexpected network calls during interaction.

Separate props for every chart would make the caller join geographies and
sources. One demographics prop keeps that join local. Growth and household
selectors remain independent because published lists can differ. Age and median
income share household selection. Thresholds update all household cards together.

## Statechart

```mermaid
stateDiagram-v2
  [*] --> Hidden: demographics absent
  [*] --> Visible: demographics present
  Hidden --> Visible: publication provides data
  Visible --> Hidden: publication removes data
  Visible --> Visible: select growth geography
  Visible --> Visible: select household geography
  Visible --> Visible: select income threshold
  Visible --> Visible: replace publication and resolve valid selections
```

State contains selected growth name, household name and threshold. Resolved
selections belong to the current publication or fall back to its first entry.
Values and sources derive synchronously from those selections. DOM tests cover
each transition. Transport and persistence belong to the shell.

The committed TLA+ model passed TLC with 26 states and 165 steps.
SelectionBelongsToPublication and NoDeadlock hold. Reproduce with the pstack
statechart runner against test/models/demographics-core/Selection.tla and its
Selection.cfg. This proves the bounded selection model, not the React code.

The pinned schema has no explicit core age year, age population count,
median-income source URL or income year. Preserve household notes, income
captions and methodology rather than inventing facts. The median section labels
the age source as household context, with general methodology alongside it.

## Remaining proof

Synthetic tests do not establish private-reference visual parity. The assigned
rows need the Studio parity run, including V-A07 and V-A08. S15 owns micro-zones
and competition. Production proof requires shell integration and a published
portal. Select two geographies and a threshold, then compare values,
denominators, years and source links with the publication without charts.

## Design and debt pass

codebase-design keeps one injected data seam and local geography joins. No
caller must coordinate a value with a separate source state.
zero-tech-debt reuses the existing theme tokens and leaves router, loader and
bundling with S10. The diff adds a new module, synthetic fixture and tests;
there is no existing demographics implementation to delete. No code comments,
casts, suppressions or compatibility modes were introduced.
