# Home working disclosure

Slice owns the mounted disclosure boolean. HomeSections owns search, grouping and the current/pinned projection. CARR owns source state and receipts. This verification-only revision changes no application behavior, contracts, storage, calls or capacity. The bounded 1,000-card snapshot and stale/refusal behavior remain unchanged.

## Transition coverage

Disclosure, canonical placement, selection and search change independently. The chart gives each its own region instead of mixing these dimensions into overlapping display states. Closed/populated is Closed plus Working. Filtered/open is Open plus Working plus Filtered. Selected cards remain reachable in either disclosure state. Following an exact-card URL remounts closed and clears search.

Each row names the source, destination, event and executable test in `test/home-sections-browser.test.mjs`. Width/theme suffixes on `working disclosure keyboard search refresh remount` cover 390px and 1440px in light and dark.

| Region | From | Event | To | Test name |
| --- | --- | --- | --- | --- |
| Disclosure | [*] | Initial mount | Closed | working section closed with 0 cards |
| Disclosure | Closed | Open section | Open | working disclosure keyboard search refresh remount |
| Disclosure | Open | Close section | Closed | working disclosure keyboard search refresh remount |
| Disclosure | Closed | Refresh cards | Closed | working empty refresh populates closed and hidden refresh stays closed; working disclosure keyboard search refresh remount |
| Disclosure | Open | Refresh cards | Open | working empty refresh populates closed and hidden refresh stays closed; working disclosure keyboard search refresh remount |
| Disclosure | Closed | Search cards | Closed | working disclosure keyboard search refresh remount |
| Disclosure | Open | Search cards | Open | working disclosure keyboard search refresh remount |
| Disclosure | Closed | Clear search | Closed | working disclosure keyboard search refresh remount |
| Disclosure | Open | Clear search | Open | working disclosure keyboard search refresh remount |
| Disclosure | Closed | Work needs review | Closed | working refresh moves attention and resolved cards closed |
| Disclosure | Open | Work needs review | Open | working refresh moves attention and resolved cards open |
| Disclosure | Closed | Work resolves | Closed | working refresh moves attention and resolved cards closed |
| Disclosure | Open | Work resolves | Open | working refresh moves attention and resolved cards open |
| Disclosure | Closed | Select card | Closed | working select exact card from hidden; working select exact card from visible |
| Disclosure | Open | Select card | Closed | working select exact card from hidden; working select exact card from visible |
| Disclosure | Closed | Remount Home | Closed | working Hidden remount transition |
| Disclosure | Open | Remount Home | Closed | working Visible remount transition |
| Disclosure | Closed | Invalidate session | Closed | working Hidden invalidate transition |
| Disclosure | Open | Invalidate session | Closed | working Visible invalidate transition |
| Placement | [*] | Initial mount | Empty | working section closed with 0 cards |
| Placement | Empty | Refresh cards | Working | working empty refresh populates closed and hidden refresh stays closed; working disclosure keyboard search refresh remount |
| Placement | Working | Refresh cards | Working | working empty refresh populates closed and hidden refresh stays closed; working disclosure keyboard search refresh remount |
| Placement | Working | Work needs review | Attention | working refresh moves attention and resolved cards closed |
| Placement | Working | Work resolves | Done | working refresh moves attention and resolved cards closed |
| Placement | Empty | Remount Home | Empty | working Empty remount transition |
| Placement | Working | Remount Home | Working | working Hidden remount transition |
| Placement | Attention | Remount Home | Attention | working Attention remount transition |
| Placement | Done | Remount Home | Done | working Done remount transition |
| Placement | Empty | Invalidate session | Empty | working Empty invalidate transition |
| Placement | Working | Invalidate session | Empty | working Hidden invalidate transition |
| Placement | Attention | Invalidate session | Empty | working Attention invalidate transition |
| Placement | Done | Invalidate session | Empty | working Done invalidate transition |
| Selection | [*] | Initial mount | Ordinary | working section closed with 0 cards |
| Selection | Ordinary | Select card | Selected | working select exact card from hidden; working select exact card from visible |
| Selection | Selected | Open section | Selected | closed working section preserves selected card without first preview |
| Selection | Selected | Close section | Selected | closed working section preserves selected card without first preview |
| Selection | Selected | Refresh cards | Selected | working selected refresh retains disclosure closed; working selected refresh retains disclosure open |
| Selection | Selected | Remount Home | Selected | working Selected remount transition; working selected open remount closes and retains exact card |
| Selection | Ordinary | Invalidate session | Ordinary | working Hidden invalidate transition |
| Selection | Selected | Invalidate session | Ordinary | working Selected invalidate transition |
| Search | [*] | Initial mount | All | working section closed with 0 cards |
| Search | All | Search cards | Filtered | working disclosure keyboard search refresh remount |
| Search | Filtered | Clear search | All | working disclosure keyboard search refresh remount |
| Search | Filtered | Select card | All | working select exact card from hidden; working select exact card from visible |
| Search | All | Remount Home | All | working Hidden remount transition |
| Search | Filtered | Remount Home | All | working Filtered remount transition |
| Search | All | Invalidate session | All | working Hidden invalidate transition |
| Search | Filtered | Invalidate session | All | working Filtered invalidate transition |

The eight rendered-state remount/invalidation cases additionally cover Empty, Hidden, Visible, Filtered, FilteredOpen, Selected, Attention and Done. Existing [lifecycle coverage](home-inbox-v3.mmd) retains canonical completion reasons, snooze, wake, hide and undo assertions. The disclosure test compares actual RPC lists before and after toggles. Session invalidation asserts all rows and controls disappear, rather than pretending the signed-out app renders an empty section.

## Reproduce the model

The model, configuration and labels below replace the unversioned scratch dependency. They stay in this note to preserve the plan's path scope. Extract them beside a copy of the chart into an existing scratch directory. Run this Python block from the repository root with MODEL_DIR set to that directory.

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

Run `node /Users/booko/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/statechart/scripts/statechart.mjs from-chart "$MODEL_DIR/home-working-section.mmd"`. Supply TLA2TOOLS and JAVA for installed TLC and Java. All six feature rules and TypeOK must hold, and the model must draw the chart back unchanged.

OrdinaryClosed prohibits ordinary closed rows. SearchClosed checks that search never opens the section. SelectedReachable checks both selected projection and retention across toggle, refresh and remount. AttentionOutsideWorking excludes attention from working rows. DisclosureNoRPC checks event metadata. RefreshKeepsChoice checks the previous disclosure value. These are the five required never rules, with search separately checked. They require projections and previous-event values, so they live in the versioned companion model rather than chart-only forbidden state pairs. Changing Selected to Ordinary on Close section must break SelectedReachable. Browser assertions remain the actual transport and rendering evidence. This bounded model does not prove producer correctness, authentication, retries, concurrency or production data. Search abstracts a filter that can match only the selected row. Placement abstracts the working/held/snoozed union.

```tla
---- MODULE HomeWorkingSection ----

VARIABLES disclosure, placement, selection, search, priorDisclosure, priorSelection, event, rpc
vars == <<disclosure, placement, selection, search, priorDisclosure, priorSelection, event, rpc>>

disclosureStates == {"Closed", "Open"}
placementStates == {"Attention", "Done", "Empty", "Working"}
selectionStates == {"Ordinary", "Selected"}
searchStates == {"All", "Filtered"}

TypeOK ==
    /\ disclosure \in disclosureStates
    /\ placement \in placementStates
    /\ selection \in selectionStates
    /\ search \in searchStates

Init ==
    /\ disclosure = "Closed"
    /\ placement = "Empty"
    /\ selection = "Ordinary"
    /\ search = "All"
    /\ priorDisclosure = "Closed"
    /\ priorSelection = "Ordinary"
    /\ event = "Init"
    /\ rpc = FALSE

\* src/ui/home/sections.tsx:24
OpenSection ==
    /\ priorDisclosure' = disclosure
    /\ priorSelection' = selection
    /\ event' = "OpenSection"
    /\ rpc' = FALSE
    /\ (disclosure \in {"Closed"} \/ selection \in {"Selected"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Open")
       \/ (disclosure \notin {"Closed"} /\ UNCHANGED disclosure)
    /\ \/ (selection = "Selected" /\ selection' = "Selected")
       \/ (selection \notin {"Selected"} /\ UNCHANGED selection)
    /\ UNCHANGED <<placement, search>>

\* src/ui/home/sections.tsx:24
CloseSection ==
    /\ priorDisclosure' = disclosure
    /\ priorSelection' = selection
    /\ event' = "CloseSection"
    /\ rpc' = FALSE
    /\ (disclosure \in {"Open"} \/ selection \in {"Selected"})
    /\ \/ (disclosure = "Open" /\ disclosure' = "Closed")
       \/ (disclosure \notin {"Open"} /\ UNCHANGED disclosure)
    /\ \/ (selection = "Selected" /\ selection' = "Selected")
       \/ (selection \notin {"Selected"} /\ UNCHANGED selection)
    /\ UNCHANGED <<placement, search>>

\* src/ui/home/sections.tsx:21
RefreshCards ==
    /\ priorDisclosure' = disclosure
    /\ priorSelection' = selection
    /\ event' = "RefreshCards"
    /\ rpc' = TRUE
    /\ (disclosure \in {"Closed", "Open"} \/ placement \in {"Empty", "Working"} \/ selection \in {"Selected"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Open")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Empty" /\ placement' = "Working")
       \/ (placement = "Working" /\ placement' = "Working")
       \/ (placement \notin {"Empty", "Working"} /\ UNCHANGED placement)
    /\ \/ (selection = "Selected" /\ selection' = "Selected")
       \/ (selection \notin {"Selected"} /\ UNCHANGED selection)
    /\ UNCHANGED <<search>>

\* src/ui/home/sections.tsx:49
SearchCards ==
    /\ priorDisclosure' = disclosure
    /\ priorSelection' = selection
    /\ event' = "SearchCards"
    /\ rpc' = FALSE
    /\ (disclosure \in {"Closed", "Open"} \/ search \in {"All"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Open")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (search = "All" /\ search' = "Filtered")
       \/ (search \notin {"All"} /\ UNCHANGED search)
    /\ UNCHANGED <<placement, selection>>

\* src/ui/home/sections.tsx:49
ClearSearch ==
    /\ priorDisclosure' = disclosure
    /\ priorSelection' = selection
    /\ event' = "ClearSearch"
    /\ rpc' = FALSE
    /\ (disclosure \in {"Closed", "Open"} \/ search \in {"Filtered"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Open")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (search = "Filtered" /\ search' = "All")
       \/ (search \notin {"Filtered"} /\ UNCHANGED search)
    /\ UNCHANGED <<placement, selection>>

\* src/ui/home/sections.tsx:67
WorkNeedsReview ==
    /\ priorDisclosure' = disclosure
    /\ priorSelection' = selection
    /\ event' = "WorkNeedsReview"
    /\ rpc' = TRUE
    /\ (disclosure \in {"Closed", "Open"} \/ placement \in {"Working"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Open")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Working" /\ placement' = "Attention")
       \/ (placement \notin {"Working"} /\ UNCHANGED placement)
    /\ UNCHANGED <<selection, search>>

\* src/ui/home/sections.tsx:69
WorkResolves ==
    /\ priorDisclosure' = disclosure
    /\ priorSelection' = selection
    /\ event' = "WorkResolves"
    /\ rpc' = TRUE
    /\ (disclosure \in {"Closed", "Open"} \/ placement \in {"Working"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Open")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Working" /\ placement' = "Done")
       \/ (placement \notin {"Working"} /\ UNCHANGED placement)
    /\ UNCHANGED <<selection, search>>

\* src/ui/home/sections.tsx:50
SelectCard ==
    /\ priorDisclosure' = disclosure
    /\ priorSelection' = selection
    /\ event' = "SelectCard"
    /\ rpc' = TRUE
    /\ (disclosure \in {"Closed", "Open"} \/ selection \in {"Ordinary"} \/ search \in {"Filtered"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Closed")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (selection = "Ordinary" /\ selection' = "Selected")
       \/ (selection \notin {"Ordinary"} /\ UNCHANGED selection)
    /\ \/ (search = "Filtered" /\ search' = "All")
       \/ (search \notin {"Filtered"} /\ UNCHANGED search)
    /\ UNCHANGED <<placement>>

\* src/ui/home/sections.tsx:21
RemountHome ==
    /\ priorDisclosure' = disclosure
    /\ priorSelection' = selection
    /\ event' = "RemountHome"
    /\ rpc' = TRUE
    /\ (disclosure \in {"Closed", "Open"} \/ placement \in {"Empty", "Working", "Attention", "Done"} \/ selection \in {"Selected"} \/ search \in {"All", "Filtered"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Closed")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Empty" /\ placement' = "Empty")
       \/ (placement = "Working" /\ placement' = "Working")
       \/ (placement = "Attention" /\ placement' = "Attention")
       \/ (placement = "Done" /\ placement' = "Done")
       \/ (placement \notin {"Empty", "Working", "Attention", "Done"} /\ UNCHANGED placement)
    /\ \/ (selection = "Selected" /\ selection' = "Selected")
       \/ (selection \notin {"Selected"} /\ UNCHANGED selection)
    /\ \/ (search = "All" /\ search' = "All")
       \/ (search = "Filtered" /\ search' = "All")
       \/ (search \notin {"All", "Filtered"} /\ UNCHANGED search)

\* src/ui/home/sections.tsx:21
InvalidateSession ==
    /\ priorDisclosure' = disclosure
    /\ priorSelection' = selection
    /\ event' = "InvalidateSession"
    /\ rpc' = FALSE
    /\ (disclosure \in {"Closed", "Open"} \/ placement \in {"Empty", "Working", "Attention", "Done"} \/ selection \in {"Ordinary", "Selected"} \/ search \in {"All", "Filtered"})
    /\ \/ (disclosure = "Closed" /\ disclosure' = "Closed")
       \/ (disclosure = "Open" /\ disclosure' = "Closed")
       \/ (disclosure \notin {"Closed", "Open"} /\ UNCHANGED disclosure)
    /\ \/ (placement = "Empty" /\ placement' = "Empty")
       \/ (placement = "Working" /\ placement' = "Empty")
       \/ (placement = "Attention" /\ placement' = "Empty")
       \/ (placement = "Done" /\ placement' = "Empty")
       \/ (placement \notin {"Empty", "Working", "Attention", "Done"} /\ UNCHANGED placement)
    /\ \/ (selection = "Ordinary" /\ selection' = "Ordinary")
       \/ (selection = "Selected" /\ selection' = "Ordinary")
       \/ (selection \notin {"Ordinary", "Selected"} /\ UNCHANGED selection)
    /\ \/ (search = "All" /\ search' = "All")
       \/ (search = "Filtered" /\ search' = "All")
       \/ (search \notin {"All", "Filtered"} /\ UNCHANGED search)

Next == OpenSection \/ CloseSection \/ RefreshCards \/ SearchCards \/ ClearSearch \/ WorkNeedsReview \/ WorkResolves \/ SelectCard \/ RemountHome \/ InvalidateSession

Spec == Init /\ [][Next]_vars

Shown ==
    (IF placement = "Working" /\ selection = "Selected" THEN {"selected"} ELSE {})
    \cup (IF placement = "Working" /\ disclosure = "Open" /\ search = "All" THEN {"ordinary"} ELSE {})
OrdinaryClosed == disclosure = "Closed" => "ordinary" \notin Shown
SearchClosed == event \in {"SearchCards", "ClearSearch"} => disclosure = priorDisclosure
SelectedReachable ==
    /\ (placement = "Working" /\ selection = "Selected" => "selected" \in Shown)
    /\ (priorSelection = "Selected" /\ event \in {"OpenSection", "CloseSection", "RefreshCards", "RemountHome"} => selection = "Selected")
AttentionOutsideWorking == placement = "Attention" => Shown = {}
DisclosureNoRPC == event \in {"OpenSection", "CloseSection"} => ~rpc
RefreshKeepsChoice == event = "RefreshCards" => disclosure = priorDisclosure
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
export const regions = ["disclosure","placement","selection","search"];
const LABELS = {
	"OpenSection": "Open section",
	"CloseSection": "Close section",
	"RefreshCards": "Refresh cards",
	"SearchCards": "Search cards",
	"ClearSearch": "Clear search",
	"WorkNeedsReview": "Work needs review",
	"WorkResolves": "Work resolves",
	"SelectCard": "Select card",
	"RemountHome": "Remount Home",
	"InvalidateSession": "Invalidate session"
};

export const readerActions = [];
export const state = (v) => regions.map((r) => v[r]).join(" | ");
export const step = (action) => LABELS[action] ?? action;
```

## Production proof

After a containing deployment, independently read `/app-release` with the existing release reader and verify source containment of the merge SHA. In the signed-in proof browser compare natural parsed read-home-inbox-v5 working IDs/count with closed, opened and closed Home at both widths. Follow an existing exact-card link. Zero natural working cards means insufficient evidence. Do not mutate business records for this display proof. Full AC-INBOX also needs the historical canonical source receipts and persisted disposition observations specified in the J59 plan. Local fixtures do not establish that criterion.
