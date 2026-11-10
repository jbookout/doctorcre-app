---- MODULE Selection ----
EXTENDS Naturals, TLC
VARIABLES visible, publication, growth, household, threshold
vars == <<visible, publication, growth, household, threshold>>
Keys(p) == {<<p, 0>>, <<p, 1>>}
Thresholds(p) == IF p = 0 THEN {0, 1, 2} ELSE {2}
Init == /\ visible = FALSE /\ publication = 0 /\ growth = <<0, 0>> /\ household = <<0, 0>> /\ threshold = 0
Show == /\ visible' = TRUE /\ UNCHANGED <<publication, growth, household, threshold>>
Hide == /\ visible' = FALSE /\ UNCHANGED <<publication, growth, household, threshold>>
Growth == /\ visible /\ growth' \in Keys(publication) /\ UNCHANGED <<visible, publication, household, threshold>>
Household == /\ visible /\ household' \in Keys(publication) /\ UNCHANGED <<visible, publication, growth, threshold>>
Threshold == /\ visible /\ threshold' \in Thresholds(publication) /\ UNCHANGED <<visible, publication, growth, household>>
Replace == /\ publication' = 1 /\ growth' = <<1, 0>> /\ household' = <<1, 0>> /\ threshold' = 2 /\ UNCHANGED visible
Next == Show \/ Hide \/ Growth \/ Household \/ Threshold \/ Replace
SelectionBelongsToPublication == /\ growth \in Keys(publication) /\ household \in Keys(publication) /\ threshold \in Thresholds(publication)
Spec == Init /\ [][Next]_vars
====
