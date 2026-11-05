----------------------------- MODULE Receipt -----------------------------
EXTENDS TLC
VARIABLE phase, accepted
vars == <<phase, accepted>>
Init == /\ phase = "planned" /\ accepted = FALSE
Start == /\ phase = "planned" /\ phase' = "started" /\ UNCHANGED accepted
End == /\ phase = "started" /\ phase' \in {"pass", "fail", "skip", "cancelled"} /\ UNCHANGED accepted
Missing == /\ phase = "planned" /\ phase' = "never-executed" /\ UNCHANGED accepted
Interrupt == /\ phase = "started" /\ phase' = "cancelled" /\ UNCHANGED accepted
Admit == /\ phase = "pass" /\ accepted' = TRUE /\ UNCHANGED phase
Done == /\ phase \in {"pass", "fail", "skip", "cancelled", "never-executed"} /\ UNCHANGED vars
Next == Start \/ End \/ Missing \/ Interrupt \/ Admit \/ Done
PassOnly == accepted => phase = "pass"
=============================================================================
