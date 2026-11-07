---- MODULE ResearchAttention ----
\* Refined from chart-to-tla.mjs output. Concrete fields follow the workspace and renderer.
\* The fixture supplies one research state and guidance. This model checks their preservation, not producer correctness.
\* Each region is one variable and each transition label is one action.
\* Once you add guards and variables from the real code, this file is the source.
\* statechart.mjs from-chart research-attention.mmd keeps it, checks it, and compares it with the chart.

EXTENDS TLC, Naturals

VARIABLES detailEpoch, stateActor, attention, kind, subject, evidence, activity, calls, researchAttention, previousAttention, detailId, researchSubject, previousResearchSubject, researchState, nextStep, previousState, previousNextStep
vars == <<detailEpoch, stateActor, attention, kind, subject, evidence, activity, calls, researchAttention, previousAttention, detailId, researchSubject, previousResearchSubject, researchState, nextStep, previousState, previousNextStep>>

\* Region Attention
attentionStates == {"All findings", "Attention selected"}
\* Region Kind
kindStates == {"All finding kinds", "One finding kind"}
\* Region Subject
subjectStates == {"Current lead authorized", "Panel disposed", "Signed out"}
\* Region Evidence
evidenceStates == {"Current research shown", "Research cleared"}
\* Region Activity
activityStates == {"All findings refreshed", "Authorization retired", "Authorized panel reopened", "Current lead repainted", "Different lead opened", "Late response ignored", "No matching findings", "Panel closed", "Panel opened", "Selected attention refreshed", "Selector changed"}
\* Region Calls
callsStates == {"Explicit read added", "No request added"}

TypeOK ==
    /\ detailEpoch \in {0, 1}
    /\ stateActor = "partner"
    /\ researchAttention \in {"", "correction", "expired", "nothing"}
    /\ previousAttention \in {"", "correction", "expired", "nothing"}
    /\ detailId \in {"A", "B", "none"}
    /\ researchSubject \in {"A", "B", "none"}
    /\ previousResearchSubject \in {"A", "B", "none"}
    /\ researchState \in {"needs_review", "verified"}
    /\ nextStep \in {"Review original sources", "Changed"}
    /\ previousState \in {"needs_review", "verified"}
    /\ previousNextStep \in {"Review original sources", "Changed"}
    /\ attention \in attentionStates
    /\ kind \in kindStates
    /\ subject \in subjectStates
    /\ evidence \in evidenceStates
    /\ activity \in activityStates
    /\ calls \in callsStates

Init ==
    /\ detailEpoch = 0
    /\ stateActor = "partner"
    /\ researchAttention = ""
    /\ previousAttention = ""
    /\ detailId = "A"
    /\ researchSubject = "A"
    /\ previousResearchSubject = "A"
    /\ researchState = "needs_review"
    /\ nextStep = "Review original sources"
    /\ previousState = researchState
    /\ previousNextStep = nextStep
    /\ attention = "All findings"
    /\ kind = "All finding kinds"
    /\ subject = "Current lead authorized"
    /\ evidence = "Current research shown"
    /\ activity = "Panel opened"
    /\ calls = "No request added"


SelectAttention ==
    /\ subject = "Current lead authorized" \* src/ui/lead-research.tsx:40
    /\ attention' = "Attention selected" \* src/ui/lead-research.tsx:40
    /\ researchAttention' \in {"correction", "expired", "nothing"} \* src/ui/lead-research.tsx:40
    /\ activity' = "Selector changed" \* src/ui/lead-research.tsx:40
    /\ calls' = "No request added" \* src/ui/lead-research.tsx:40
    /\ previousAttention' = researchAttention \* src/ui/lead-research.tsx:40
    /\ previousResearchSubject' = researchSubject \* src/ui/lead-research.tsx:40
    /\ previousState' = researchState \* src/ui/lead-research.tsx:40
    /\ previousNextStep' = nextStep \* src/ui/lead-research.tsx:40
    /\ UNCHANGED <<detailEpoch, stateActor, kind, subject, evidence, detailId, researchSubject, researchState, nextStep>> \* src/ui/lead-research.tsx:40

ClearAttention ==
    /\ subject = "Current lead authorized" \* src/ui/lead-research.tsx:42
    /\ attention' = "All findings" \* src/ui/lead-research.tsx:42
    /\ researchAttention' = "" \* src/ui/lead-research.tsx:42
    /\ activity' = "Selector changed" \* src/ui/lead-research.tsx:42
    /\ calls' = "No request added" \* src/ui/lead-research.tsx:42
    /\ previousAttention' = researchAttention \* src/ui/lead-research.tsx:42
    /\ previousResearchSubject' = researchSubject \* src/ui/lead-research.tsx:42
    /\ previousState' = researchState \* src/ui/lead-research.tsx:42
    /\ previousNextStep' = nextStep \* src/ui/lead-research.tsx:42
    /\ UNCHANGED <<detailEpoch, stateActor, kind, subject, evidence, detailId, researchSubject, researchState, nextStep>> \* src/ui/lead-research.tsx:42

SelectKind ==
    /\ subject = "Current lead authorized" \* src/ui/lead-research.tsx:39
    /\ kind' = "One finding kind" \* src/ui/lead-research.tsx:39
    /\ activity' = "Selector changed" \* src/ui/lead-research.tsx:39
    /\ calls' = "No request added" \* src/ui/lead-research.tsx:39
    /\ previousAttention' = researchAttention \* src/ui/lead-research.tsx:39
    /\ previousResearchSubject' = researchSubject \* src/ui/lead-research.tsx:39
    /\ previousState' = researchState \* src/ui/lead-research.tsx:39
    /\ previousNextStep' = nextStep \* src/ui/lead-research.tsx:39
    /\ UNCHANGED <<detailEpoch, stateActor, attention, subject, evidence, researchAttention, detailId, researchSubject, researchState, nextStep>> \* src/ui/lead-research.tsx:39

ClearKind ==
    /\ subject = "Current lead authorized" \* src/ui/lead-research.tsx:39
    /\ kind' = "All finding kinds" \* src/ui/lead-research.tsx:39
    /\ activity' = "Selector changed" \* src/ui/lead-research.tsx:39
    /\ calls' = "No request added" \* src/ui/lead-research.tsx:39
    /\ previousAttention' = researchAttention \* src/ui/lead-research.tsx:39
    /\ previousResearchSubject' = researchSubject \* src/ui/lead-research.tsx:39
    /\ previousState' = researchState \* src/ui/lead-research.tsx:39
    /\ previousNextStep' = nextStep \* src/ui/lead-research.tsx:39
    /\ UNCHANGED <<detailEpoch, stateActor, attention, subject, evidence, researchAttention, detailId, researchSubject, researchState, nextStep>> \* src/ui/lead-research.tsx:39

SameLeadRefresh ==
    /\ subject = "Current lead authorized" \* js/leads-workspace-app.js:329
    /\ activity' = IF researchAttention = "" THEN "All findings refreshed" ELSE "Selected attention refreshed" \* js/leads-workspace-app.js:329
    /\ calls' = "Explicit read added" \* js/leads-workspace-app.js:329
    /\ previousAttention' = researchAttention \* js/leads-workspace-app.js:329
    /\ previousResearchSubject' = researchSubject \* js/leads-workspace-app.js:329
    /\ previousState' = researchState \* js/leads-workspace-app.js:329
    /\ previousNextStep' = nextStep \* js/leads-workspace-app.js:329
    /\ detailEpoch' = 1 - detailEpoch \* js/leads-workspace-app.js:399
    /\ UNCHANGED <<stateActor, attention, kind, subject, evidence, researchAttention, detailId, researchSubject, researchState, nextStep>> \* js/leads-workspace-app.js:329

SameLeadRepaint ==
    /\ subject = "Current lead authorized" \* js/leads-workspace-app.js:329
    /\ activity' = "Current lead repainted" \* js/leads-workspace-app.js:329
    /\ calls' = "No request added" \* js/leads-workspace-app.js:329
    /\ previousAttention' = researchAttention \* js/leads-workspace-app.js:329
    /\ previousResearchSubject' = researchSubject \* js/leads-workspace-app.js:329
    /\ previousState' = researchState \* js/leads-workspace-app.js:329
    /\ previousNextStep' = nextStep \* js/leads-workspace-app.js:329
    /\ UNCHANGED <<detailEpoch, stateActor, attention, kind, subject, evidence, researchAttention, detailId, researchSubject, researchState, nextStep>> \* js/leads-workspace-app.js:329

LeadChange ==
    /\ subject = "Current lead authorized" \* js/leads-workspace-app.js:399
    /\ attention' = "All findings" \* js/leads-workspace-app.js:399
    /\ kind' = "All finding kinds" \* js/leads-workspace-app.js:399
    /\ researchAttention' = "" \* js/leads-workspace-app.js:399
    /\ detailId' = IF detailId = "A" THEN "B" ELSE "A" \* js/leads-workspace-app.js:399
    /\ researchSubject' = IF detailId = "A" THEN "B" ELSE "A" \* js/leads-workspace-app.js:399
    /\ evidence' = "Current research shown" \* js/leads-workspace-app.js:399
    /\ activity' = "Different lead opened" \* js/leads-workspace-app.js:399
    /\ calls' = "Explicit read added" \* js/leads-workspace-app.js:399
    /\ previousAttention' = researchAttention \* js/leads-workspace-app.js:399
    /\ previousResearchSubject' = researchSubject \* js/leads-workspace-app.js:399
    /\ previousState' = researchState \* js/leads-workspace-app.js:399
    /\ previousNextStep' = nextStep \* js/leads-workspace-app.js:399
    /\ detailEpoch' = 1 - detailEpoch \* js/leads-workspace-app.js:399
    /\ UNCHANGED <<stateActor, subject, researchState, nextStep>> \* js/leads-workspace-app.js:399

AuthorizationRetirement ==
    /\ subject = "Current lead authorized" \* js/leads-workspace-app.js:725
    /\ attention' = "All findings" \* js/leads-workspace-app.js:725
    /\ kind' = "All finding kinds" \* js/leads-workspace-app.js:725
    /\ researchAttention' = "" \* js/leads-workspace-app.js:725
    /\ subject' = "Signed out" \* js/leads-workspace-app.js:725
    /\ detailId' = "none" \* js/leads-workspace-app.js:725
    /\ researchSubject' = "none" \* js/leads-workspace-app.js:725
    /\ evidence' = "Research cleared" \* js/leads-workspace-app.js:725
    /\ activity' = "Authorization retired" \* js/leads-workspace-app.js:725
    /\ calls' = "No request added" \* js/leads-workspace-app.js:725
    /\ previousAttention' = researchAttention \* js/leads-workspace-app.js:725
    /\ previousResearchSubject' = researchSubject \* js/leads-workspace-app.js:725
    /\ previousState' = researchState \* js/leads-workspace-app.js:725
    /\ previousNextStep' = nextStep \* js/leads-workspace-app.js:725
    /\ detailEpoch' = 1 - detailEpoch \* js/leads-workspace-app.js:726
    /\ UNCHANGED <<stateActor, researchState, nextStep>> \* js/leads-workspace-app.js:725

Disposal ==
    /\ subject # "Panel disposed" \* js/leads-workspace-app.js:740
    /\ attention' = "All findings" \* js/leads-workspace-app.js:740
    /\ kind' = "All finding kinds" \* js/leads-workspace-app.js:740
    /\ researchAttention' = "" \* js/leads-workspace-app.js:740
    /\ subject' = "Panel disposed" \* js/leads-workspace-app.js:740
    /\ detailId' = "none" \* js/leads-workspace-app.js:740
    /\ researchSubject' = "none" \* js/leads-workspace-app.js:740
    /\ evidence' = "Research cleared" \* js/leads-workspace-app.js:740
    /\ activity' = "Panel closed" \* js/leads-workspace-app.js:740
    /\ calls' = "No request added" \* js/leads-workspace-app.js:740
    /\ previousAttention' = researchAttention \* js/leads-workspace-app.js:740
    /\ previousResearchSubject' = researchSubject \* js/leads-workspace-app.js:740
    /\ previousState' = researchState \* js/leads-workspace-app.js:740
    /\ previousNextStep' = nextStep \* js/leads-workspace-app.js:740
    /\ detailEpoch' = 1 - detailEpoch \* js/leads-workspace-app.js:726
    /\ UNCHANGED <<stateActor, researchState, nextStep>> \* js/leads-workspace-app.js:740

AuthorizedReopen ==
    /\ subject = "Signed out" \* js/leads-workspace-app.js:399
    /\ subject' = "Current lead authorized" \* js/leads-workspace-app.js:399
    /\ detailId' = "A" \* js/leads-workspace-app.js:399
    /\ researchSubject' = "A" \* js/leads-workspace-app.js:399
    /\ evidence' = "Current research shown" \* js/leads-workspace-app.js:399
    /\ activity' = "Authorized panel reopened" \* js/leads-workspace-app.js:399
    /\ calls' = "Explicit read added" \* js/leads-workspace-app.js:399
    /\ previousAttention' = researchAttention \* js/leads-workspace-app.js:399
    /\ previousResearchSubject' = researchSubject \* js/leads-workspace-app.js:399
    /\ previousState' = researchState \* js/leads-workspace-app.js:399
    /\ previousNextStep' = nextStep \* js/leads-workspace-app.js:399
    /\ detailEpoch' = 1 - detailEpoch \* js/leads-workspace-app.js:399
    /\ UNCHANGED <<stateActor, attention, kind, researchAttention, researchState, nextStep>> \* js/leads-workspace-app.js:399

LateReadArrival ==
    \E epoch \in {0, 1}, actor \in {"partner", "other"}:
      /\ (epoch # detailEpoch \/ actor # stateActor) \* js/leads-workspace-app.js:401
      \* js/leads-workspace-app.js:396-401 captures epoch and actor, rejects retired read before paint.
      /\ activity' = "Late response ignored" \* js/leads-workspace-app.js:401
      /\ calls' = "No request added" \* js/leads-workspace-app.js:401
      /\ previousAttention' = researchAttention \* js/leads-workspace-app.js:401
      /\ previousResearchSubject' = researchSubject \* js/leads-workspace-app.js:401
      /\ previousState' = researchState \* js/leads-workspace-app.js:401
      /\ previousNextStep' = nextStep \* js/leads-workspace-app.js:401
      /\ UNCHANGED <<detailEpoch, stateActor, attention, kind, subject, evidence, researchAttention, detailId, researchSubject, researchState, nextStep>> \* js/leads-workspace-app.js:401

ZeroMatch ==
    /\ subject = "Current lead authorized" \* src/ui/lead-research.tsx:34
    /\ activity' = "No matching findings" \* src/ui/lead-research.tsx:34
    /\ calls' = "No request added" \* src/ui/lead-research.tsx:34
    /\ previousAttention' = researchAttention \* src/ui/lead-research.tsx:34
    /\ previousResearchSubject' = researchSubject \* src/ui/lead-research.tsx:34
    /\ previousState' = researchState \* src/ui/lead-research.tsx:34
    /\ previousNextStep' = nextStep \* src/ui/lead-research.tsx:34
    /\ UNCHANGED <<detailEpoch, stateActor, attention, kind, subject, evidence, researchAttention, detailId, researchSubject, researchState, nextStep>> \* src/ui/lead-research.tsx:34

Next == SelectAttention \/ ClearAttention \/ SelectKind \/ ClearKind \/ SameLeadRefresh \/ SameLeadRepaint \/ LeadChange \/ AuthorizationRetirement \/ Disposal \/ AuthorizedReopen \/ LateReadArrival \/ ZeroMatch

Spec == Init /\ [][Next]_vars

\* js/leads-workspace-app.js:329-343 saves attention before clearing and restores it.
RetainSameLead == activity \in {"Selected attention refreshed", "All findings refreshed", "Current lead repainted"} => researchAttention = previousAttention
\* js/leads-workspace-app.js:399 clears the old research owner before opening another lead.
ResetLead == activity = "Different lead opened" => researchAttention = ""
\* js/leads-workspace-app.js:725 calls clearGuidance, which calls clearResearch at line 38.
ResetAuthorization == subject = "Signed out" => researchAttention = ""
\* js/leads-workspace-app.js:740 disposes through suspendPrivateView and clearResearch at line 36.
ResetDisposal == subject = "Panel disposed" => researchAttention = ""
\* js/leads-workspace-app.js:401 rejects an obsolete epoch or actor before rendering.
LateSubjectBoundary == /\ (activity = "Late response ignored" => researchSubject = previousResearchSubject)
                       /\ (researchSubject # "none" => researchSubject = detailId)
\* src/ui/lead-research.tsx:39-43 invokes only local setters and selection callbacks at workspace line 343.
FilteringNoRequest == activity \in {"Selector changed", "No matching findings"} => calls = "No request added"
\* src/ui/lead-research.tsx:34-46 filters evidence and prints untouched research.state and next_step.
ZeroMatchGuidance == activity = "No matching findings" => /\ researchState = previousState
                                                          /\ nextStep = previousNextStep

====
