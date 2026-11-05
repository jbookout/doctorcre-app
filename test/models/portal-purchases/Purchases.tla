---- MODULE Purchases ----
EXTENDS Naturals, FiniteSets
VARIABLES selected, visible, proposed, map
vars == <<selected, visible, proposed, map>>
Init == /\ selected = 0 /\ visible = {1,2} /\ proposed = {} /\ map = "starting"
Select == \E id \in visible: /\ selected' = id /\ UNCHANGED <<visible, proposed, map>>
Filter == \E ids \in SUBSET {1,2}: /\ visible' = ids /\ selected' = 0 /\ UNCHANGED <<proposed, map>>
Close == /\ selected' = 0 /\ UNCHANGED <<visible, proposed, map>>
Reset == /\ selected' = 0 /\ visible' = {1,2} /\ UNCHANGED <<proposed, map>>
Toggle == /\ proposed' = (IF 1 \in proposed THEN {} ELSE {1}) /\ UNCHANGED <<selected, visible, map>>
ContextToggle == UNCHANGED vars
MapLoad == /\ map = "starting" /\ map' = "ready" /\ UNCHANGED <<selected, visible, proposed>>
MapFail == /\ map \in {"starting","ready"} /\ map' = "unavailable" /\ UNCHANGED <<selected, visible, proposed>>
Next == Select \/ Filter \/ Close \/ Reset \/ Toggle \/ ContextToggle \/ MapLoad \/ MapFail
SelectionVisible == selected = 0 \/ selected \in visible
ContextExcluded == proposed \subseteq {1}
DirectorySurvives == visible \subseteq {1,2}
Spec == Init /\ [][Next]_vars
====
