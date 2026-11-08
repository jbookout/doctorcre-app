# Home working disclosure

Slice owns the mounted disclosure boolean. HomeSections owns search, grouping and the current/pinned projection. CARR owns source state and receipts. This verification-only revision changes no application behavior, contracts, storage, calls or capacity. The existing bounded 1,000-card snapshot and stale/refusal behavior remain unchanged.

## Transition coverage

Each row names the source, destination, event and executable test in `test/home-sections-browser.test.mjs`. Width/theme suffixes on `working disclosure keyboard search refresh remount` cover 390px and 1440px in light and dark. Select card means following an exact-card URL, which remounts Home closed. Selected abstracts whether unrelated rows are also shown while open.

| Region | From | Event | To | Test name |
| --- | --- | --- | --- | --- |
| Disclosure | [*] | Initial mount | Closed | working section closed with 0 cards |
| Disclosure | Closed | Open section | Open | working disclosure keyboard search refresh remount |
| Disclosure | Open | Close section | Closed | working disclosure keyboard search refresh remount |
| Disclosure | Closed | Refresh cards | Closed | working empty refresh populates closed and hidden refresh stays closed |
| Disclosure | Open | Refresh cards | Open | working disclosure keyboard search refresh remount |
| Disclosure | Closed | Search cards | Closed | working disclosure keyboard search refresh remount |
| Disclosure | Open | Search cards | Open | working disclosure keyboard search refresh remount |
| Disclosure | Closed | Clear search | Closed | working disclosure keyboard search refresh remount |
| Disclosure | Open | Clear search | Open | working disclosure keyboard search refresh remount |
| Disclosure | Closed | Select card | Closed | working select exact card from hidden |
| Disclosure | Open | Select card | Closed | working select exact card from visible |
| Disclosure | Closed | Work needs review | Closed | working refresh moves attention and resolved cards closed |
| Disclosure | Open | Work needs review | Open | working refresh moves attention and resolved cards open |
| Disclosure | Closed | Work resolves | Closed | working refresh moves attention and resolved cards closed |
| Disclosure | Open | Work resolves | Open | working refresh moves attention and resolved cards open |
| Disclosure | Closed | Remount Home | Closed | working Hidden remount transition |
| Disclosure | Open | Remount Home | Closed | working Visible remount transition |
| Disclosure | Closed | Invalidate session | Closed | working Hidden invalidate transition |
| Disclosure | Open | Invalidate session | Closed | working Visible invalidate transition |
| Placement | [*] | Initial mount | Empty | working section closed with 0 cards |
| Placement | Empty | Refresh cards | Hidden | working empty refresh populates closed and hidden refresh stays closed |
| Placement | Hidden | Refresh cards | Hidden | working empty refresh populates closed and hidden refresh stays closed |
| Placement | Visible | Refresh cards | Visible | working disclosure keyboard search refresh remount |
| Placement | Selected | Refresh cards | Selected | working selected refresh retains disclosure closed; working selected refresh retains disclosure open |
| Placement | Hidden | Open section | Visible | working disclosure keyboard search refresh remount |
| Placement | Visible | Close section | Hidden | working disclosure keyboard search refresh remount |
| Placement | Hidden | Search cards | Filtered | working disclosure keyboard search refresh remount |
| Placement | Visible | Search cards | FilteredOpen | working disclosure keyboard search refresh remount |
| Placement | Filtered | Open section | FilteredOpen | working disclosure keyboard search refresh remount |
| Placement | FilteredOpen | Close section | Filtered | working disclosure keyboard search refresh remount |
| Placement | Filtered | Clear search | Hidden | working disclosure keyboard search refresh remount |
| Placement | FilteredOpen | Clear search | Visible | working disclosure keyboard search refresh remount |
| Placement | Hidden | Select card | Selected | working select exact card from hidden |
| Placement | Visible | Select card | Selected | working select exact card from visible |
| Placement | Selected | Open section | Selected | closed working section preserves selected card without first preview |
| Placement | Selected | Close section | Selected | closed working section preserves selected card without first preview |
| Placement | Hidden | Work needs review | Attention | working refresh moves attention and resolved cards closed |
| Placement | Visible | Work needs review | Attention | working refresh moves attention and resolved cards open |
| Placement | Hidden | Work resolves | Done | working refresh moves attention and resolved cards closed |
| Placement | Visible | Work resolves | Done | working refresh moves attention and resolved cards open |
| Placement | Empty | Remount Home | Empty | working Empty remount transition |
| Placement | Hidden | Remount Home | Hidden | working Hidden remount transition |
| Placement | Visible | Remount Home | Hidden | working Visible remount transition |
| Placement | Filtered | Remount Home | Hidden | working Filtered remount transition |
| Placement | FilteredOpen | Remount Home | Hidden | working FilteredOpen remount transition |
| Placement | Selected | Remount Home | Selected | working Selected remount transition; working selected open remount closes and retains exact card |
| Placement | Attention | Remount Home | Attention | working Attention remount transition |
| Placement | Done | Remount Home | Done | working Done remount transition |
| Placement | Empty | Invalidate session | Empty | working Empty invalidate transition |
| Placement | Hidden | Invalidate session | Empty | working Hidden invalidate transition |
| Placement | Visible | Invalidate session | Empty | working Visible invalidate transition |
| Placement | Filtered | Invalidate session | Empty | working Filtered invalidate transition |
| Placement | FilteredOpen | Invalidate session | Empty | working FilteredOpen invalidate transition |
| Placement | Selected | Invalidate session | Empty | working Selected invalidate transition |
| Placement | Attention | Invalidate session | Empty | working Attention invalidate transition |
| Placement | Done | Invalidate session | Empty | working Done invalidate transition |

The existing [lifecycle chart](home-inbox-v3.mmd) and lifecycle/browser suites retain canonical completion reasons, snooze, wake, hide and undo assertions. The disclosure test compares actual RPC lists before and after both toggles. Session invalidation asserts all rows and controls disappear, rather than pretending the signed-out app renders an empty working section.

## Reproduce the model

The model and configuration below are versioned here to keep the plan's path scope. They replace the unversioned scratch-only model. Extract both blocks into a scratch directory alongside a copy of [the chart](home-working-section.mmd). No historical git objects are needed. Run this extraction from the repository root with `MODEL_DIR` set to an existing scratch directory.

```python
import os
import re
import shutil
from pathlib import Path
source = Path('docs/verification/home-working-section.md').read_text()
root = Path(os.environ['MODEL_DIR'])
for language, filename in [('tla', 'HomeWorkingSection.tla'), ('cfg', 'HomeWorkingSection.cfg'), ('mjs', 'HomeWorkingSection.map.mjs')]:
    root.joinpath(filename).write_text(re.search(r'```' + language + r'\n(.*?)```', source, re.S)[1])
shutil.copyfile('docs/verification/home-working-section.mmd', root / 'home-working-section.mmd')
```

Run `node /Users/booko/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/statechart/scripts/statechart.mjs from-chart "$MODEL_DIR/home-working-section.mmd"`. Supply `TLA2TOOLS` and `JAVA` for installed TLC and Java. The mapping below retains the exact chart captions so from-chart can compare both regions. The model retains both chart regions and checks TypeOK plus all six feature rules. The SelectCard guard limits exact-card navigation to Hidden or Visible, the source rows drawn in Placement. The chart compiler cannot express this cross-region guard. Its unguarded chart comparison reports 21 differences, including unreachable Closed/Visible and Closed/FilteredOpen states. The guarded model is authoritative for these conditions. No invariant is weakened to accept those unreachable chart paths.

OrdinaryClosed and SearchClosed prohibit closed ordinary/search rows. SelectedReachable checks both visible projection and retention across toggle, search, refresh and remount, so changing Selected to Hidden on close fails. AttentionOutsideWorking checks placement after authoritative refresh. DisclosureNoRPC checks event metadata. RefreshKeepsChoice checks the prior disclosure value. Browser assertions remain the actual transport and rendering evidence. This bounded model does not prove producer correctness, authentication, retries, concurrency or production data.

```tla
---- MODULE HomeWorkingSection ----

VARIABLES disclosure, placement, lastDisclosure, lastPlacement, event, rpc
vars == <<disclosure, placement, lastDisclosure, lastPlacement, event, rpc>>

disclosureStates == {"Closed", "Open"}
placementStates == {"Attention", "Done", "Empty", "Filtered", "FilteredOpen", "Hidden", "Selected", "Visible"}

TypeOK ==
    /\ disclosure \in disclosureStates
    /\ placement \in placementStates

Init ==
    /\ disclosure = "Closed"
    /\ placement = "Empty"
    /\ lastDisclosure = "Closed"
    /\ lastPlacement = "Empty"
    /\ event = "Init"
    /\ rpc = FALSE

\* src/ui/home/sections.tsx:24
OpenSection ==
    /\ lastDisclosure' = disclosure
    /\ lastPlacement' = placement
    /\ event' = "OpenSection"
    /\ rpc' = FALSE
    /\ (disclosure \in {"Closed"} \/ placement \in {"Hidden", "Filtered", "Selected"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Open")
       \/ (disclosure \notin {"Closed"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Hidden" /\ placement' = "Visible")
       \/ (placement = "Filtered" /\ placement' = "FilteredOpen")
       \/ (placement = "Selected" /\ placement' = "Selected")
       \/ (placement \notin {"Hidden", "Filtered", "Selected"} /\ UNCHANGED placement)

\* src/ui/home/sections.tsx:24
CloseSection ==
    /\ lastDisclosure' = disclosure
    /\ lastPlacement' = placement
    /\ event' = "CloseSection"
    /\ rpc' = FALSE
    /\ (disclosure \in {"Open"} \/ placement \in {"Visible", "FilteredOpen", "Selected"})
    /\ \/ (disclosure = "Open" /\ disclosure' = "Closed")
       \/ (disclosure \notin {"Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Visible" /\ placement' = "Hidden")
       \/ (placement = "FilteredOpen" /\ placement' = "Filtered")
       \/ (placement = "Selected" /\ placement' = "Selected")
       \/ (placement \notin {"Visible", "FilteredOpen", "Selected"} /\ UNCHANGED placement)

\* src/ui/home/sections.tsx:21
RefreshCards ==
    /\ lastDisclosure' = disclosure
    /\ lastPlacement' = placement
    /\ event' = "RefreshCards"
    /\ rpc' = TRUE
    /\ (disclosure \in {"Closed", "Open"} \/ placement \in {"Empty", "Hidden", "Visible", "Selected"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Open")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Empty" /\ placement' = "Hidden")
       \/ (placement = "Hidden" /\ placement' = "Hidden")
       \/ (placement = "Visible" /\ placement' = "Visible")
       \/ (placement = "Selected" /\ placement' = "Selected")
       \/ (placement \notin {"Empty", "Hidden", "Visible", "Selected"} /\ UNCHANGED placement)

\* src/ui/home/sections.tsx:49
SearchCards ==
    /\ lastDisclosure' = disclosure
    /\ lastPlacement' = placement
    /\ event' = "SearchCards"
    /\ rpc' = FALSE
    /\ (disclosure \in {"Closed", "Open"} \/ placement \in {"Hidden", "Visible"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Open")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Hidden" /\ placement' = "Filtered")
       \/ (placement = "Visible" /\ placement' = "FilteredOpen")
       \/ (placement \notin {"Hidden", "Visible"} /\ UNCHANGED placement)

\* src/ui/home/sections.tsx:49
ClearSearch ==
    /\ lastDisclosure' = disclosure
    /\ lastPlacement' = placement
    /\ event' = "ClearSearch"
    /\ rpc' = FALSE
    /\ (disclosure \in {"Closed", "Open"} \/ placement \in {"Filtered", "FilteredOpen"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Open")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Filtered" /\ placement' = "Hidden")
       \/ (placement = "FilteredOpen" /\ placement' = "Visible")
       \/ (placement \notin {"Filtered", "FilteredOpen"} /\ UNCHANGED placement)

\* src/ui/home/sections.tsx:50
SelectCard ==
    /\ lastDisclosure' = disclosure
    /\ lastPlacement' = placement
    /\ event' = "SelectCard"
    /\ rpc' = FALSE
    /\ placement \in {"Hidden", "Visible"}
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Closed")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Hidden" /\ placement' = "Selected")
       \/ (placement = "Visible" /\ placement' = "Selected")
       \/ (placement \notin {"Hidden", "Visible"} /\ UNCHANGED placement)

\* src/ui/home/sections.tsx:67
WorkNeedsReview ==
    /\ lastDisclosure' = disclosure
    /\ lastPlacement' = placement
    /\ event' = "WorkNeedsReview"
    /\ rpc' = TRUE
    /\ (disclosure \in {"Closed", "Open"} \/ placement \in {"Hidden", "Visible"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Open")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Hidden" /\ placement' = "Attention")
       \/ (placement = "Visible" /\ placement' = "Attention")
       \/ (placement \notin {"Hidden", "Visible"} /\ UNCHANGED placement)

\* src/ui/home/sections.tsx:69
WorkResolves ==
    /\ lastDisclosure' = disclosure
    /\ lastPlacement' = placement
    /\ event' = "WorkResolves"
    /\ rpc' = TRUE
    /\ (disclosure \in {"Closed", "Open"} \/ placement \in {"Hidden", "Visible"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Open")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Hidden" /\ placement' = "Done")
       \/ (placement = "Visible" /\ placement' = "Done")
       \/ (placement \notin {"Hidden", "Visible"} /\ UNCHANGED placement)

\* src/ui/home/sections.tsx:21
RemountHome ==
    /\ lastDisclosure' = disclosure
    /\ lastPlacement' = placement
    /\ event' = "RemountHome"
    /\ rpc' = TRUE
    /\ (disclosure \in {"Closed", "Open"} \/ placement \in {"Empty", "Hidden", "Visible", "Filtered", "FilteredOpen", "Selected", "Attention", "Done"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Closed")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Empty" /\ placement' = "Empty")
       \/ (placement = "Hidden" /\ placement' = "Hidden")
       \/ (placement = "Visible" /\ placement' = "Hidden")
       \/ (placement = "Filtered" /\ placement' = "Hidden")
       \/ (placement = "FilteredOpen" /\ placement' = "Hidden")
       \/ (placement = "Selected" /\ placement' = "Selected")
       \/ (placement = "Attention" /\ placement' = "Attention")
       \/ (placement = "Done" /\ placement' = "Done")
       \/ (placement \notin {"Empty", "Hidden", "Visible", "Filtered", "FilteredOpen", "Selected", "Attention", "Done"} /\ UNCHANGED placement)

\* src/ui/home/sections.tsx:21
InvalidateSession ==
    /\ lastDisclosure' = disclosure
    /\ lastPlacement' = placement
    /\ event' = "InvalidateSession"
    /\ rpc' = FALSE
    /\ (disclosure \in {"Closed", "Open"} \/ placement \in {"Empty", "Hidden", "Visible", "Filtered", "FilteredOpen", "Selected", "Attention", "Done"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Closed")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Empty" /\ placement' = "Empty")
       \/ (placement = "Hidden" /\ placement' = "Empty")
       \/ (placement = "Visible" /\ placement' = "Empty")
       \/ (placement = "Filtered" /\ placement' = "Empty")
       \/ (placement = "FilteredOpen" /\ placement' = "Empty")
       \/ (placement = "Selected" /\ placement' = "Empty")
       \/ (placement = "Attention" /\ placement' = "Empty")
       \/ (placement = "Done" /\ placement' = "Empty")
       \/ (placement \notin {"Empty", "Hidden", "Visible", "Filtered", "FilteredOpen", "Selected", "Attention", "Done"} /\ UNCHANGED placement)

Next == OpenSection \/ CloseSection \/ RefreshCards \/ SearchCards \/ ClearSearch \/ SelectCard \/ WorkNeedsReview \/ WorkResolves \/ RemountHome \/ InvalidateSession

Spec == Init /\ [][Next]_vars

OrdinaryClosed == ~(disclosure = "Closed" /\ placement = "Visible")

SearchClosed == ~(disclosure = "Closed" /\ placement = "FilteredOpen")

Shown == IF placement = "Selected" THEN {"selected"} ELSE IF disclosure = "Open" /\ placement = "Visible" THEN {"ordinary"} ELSE {}
SelectedReachable ==
    /\ (placement = "Selected" => "selected" \in Shown)
    /\ (lastPlacement = "Selected" /\ event \in {"OpenSection", "CloseSection", "RefreshCards", "SearchCards", "ClearSearch", "RemountHome"} => placement = "Selected")
AttentionOutsideWorking == placement = "Attention" => "ordinary" \notin Shown
DisclosureNoRPC == event \in {"OpenSection", "CloseSection"} => ~rpc
RefreshKeepsChoice == event = "RefreshCards" => disclosure = lastDisclosure
====
```

```cfg
SPECIFICATION Spec
INVARIANT TypeOK
INVARIANT OrdinaryClosed
INVARIANT SearchClosed
INVARIANT SelectedReachable
INVARIANT AttentionOutsideWorking
INVARIANT DisclosureNoRPC
INVARIANT RefreshKeepsChoice
```

```mjs
export const regions = ["disclosure","placement"];
const LABELS = {
	"OpenSection": "Open section",
	"CloseSection": "Close section",
	"RefreshCards": "Refresh cards",
	"SearchCards": "Search cards",
	"ClearSearch": "Clear search",
	"SelectCard": "Select card",
	"WorkNeedsReview": "Work needs review",
	"WorkResolves": "Work resolves",
	"RemountHome": "Remount Home",
	"InvalidateSession": "Invalidate session"
};

export const readerActions = [];
export const state = (v) => regions.map((r) => v[r]).join(" | ");
export const step = (action) => LABELS[action] ?? action;
```

## Production proof

After a containing deployment, independently read `/app-release` with the existing release reader and verify source containment of the merge SHA. In the signed-in proof browser compare natural parsed read-home-inbox-v5 working IDs/count with closed, opened and closed Home at both widths. Follow an existing exact-card link. Zero natural working cards means insufficient evidence. Do not mutate business records for this display proof. Full AC-INBOX also needs the historical canonical source receipts and persisted disposition observations specified in the J59 plan. Local fixtures do not establish that criterion.
