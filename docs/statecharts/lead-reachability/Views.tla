------------------------------ MODULE Views ------------------------------
EXTENDS Naturals, FiniteSets
VARIABLES view, members, selected, source, retired
vars == <<view, members, selected, source, retired>>
Visible(v,s) == IF v = "all" THEN {1,2} ELSE IF v = "reachable" THEN {s} ELSE {1,2} \ {s}
Init == /\ view = "all" /\ members = {1,2} /\ selected = 0 /\ source = 1 /\ retired = FALSE
Choose == \E v \in {"all","reachable","research"}:
  /\ ~retired /\ view' = v /\ members' = Visible(v,source)
  /\ selected' = (IF selected \in members' THEN selected ELSE 0)
  /\ UNCHANGED <<source,retired>>
Filter == /\ ~retired /\ members' \in SUBSET Visible(view,source)
  /\ selected' = (IF selected \in members' THEN selected ELSE 0)
  /\ UNCHANGED <<view,source,retired>>
Select == /\ ~retired /\ selected' \in members /\ UNCHANGED <<view,members,source,retired>>
Refresh == /\ ~retired /\ source' \in {1,2} /\ members' = Visible(view,source')
  /\ selected' = (IF selected \in members' THEN selected ELSE 0)
  /\ UNCHANGED <<view,retired>>
Retire == /\ retired' = TRUE /\ members' = {} /\ selected' = 0 /\ UNCHANGED <<view,source>>
Next == Choose \/ Filter \/ Select \/ Refresh \/ Retire
SelectionVisible == selected = 0 \/ selected \in members
RetiredEmpty == retired => members = {} /\ selected = 0
Membership == members \subseteq Visible(view,source)
Spec == Init /\ [][Next]_vars
=============================================================================
