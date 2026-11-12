------------------------------ MODULE LeadTiming ------------------------------
EXTENDS Naturals
VARIABLES screen, revision, shown
vars == <<screen, revision, shown>>
Init == /\ screen = "Board" /\ revision = 1 /\ shown = 0
Open == /\ screen = "Board" /\ screen' = "Detail" /\ shown' = revision /\ UNCHANGED revision
Revise == /\ screen = "Detail" /\ revision < 3 /\ revision' = revision + 1 /\ shown' = revision + 1 /\ UNCHANGED screen
Withdraw == /\ screen = "Detail" /\ screen' = "Unknown" /\ shown' = 0 /\ UNCHANGED revision
Restore == /\ screen = "Unknown" /\ screen' = "Detail" /\ shown' = revision /\ UNCHANGED revision
Close == /\ screen \in {"Detail", "Unknown"} /\ screen' = "Board" /\ shown' = 0 /\ UNCHANGED revision
Retire == /\ screen # "Retired" /\ screen' = "Retired" /\ shown' = 0 /\ UNCHANGED revision
Resume == /\ screen = "Retired" /\ screen' = "Board" /\ shown' = 0 /\ UNCHANGED revision
Next == Open \/ Revise \/ Withdraw \/ Restore \/ Close \/ Retire \/ Resume
Spec == Init /\ [][Next]_vars
TypeOK == /\ screen \in {"Board", "Detail", "Unknown", "Retired"} /\ revision \in 1..3 /\ shown \in 0..3
NoUnknownSource == screen = "Unknown" => shown = 0
NoRetiredSource == screen = "Retired" => shown = 0
NoOldRevision == screen = "Detail" => shown = revision
=============================================================================
