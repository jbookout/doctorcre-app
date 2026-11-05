---------------------------- MODULE Draft ----------------------------
EXTENDS Naturals
VARIABLES phase, stored, draft
vars == <<phase, stored, draft>>
Init == /\ phase = "valid" /\ stored = 0 /\ draft = 0
EditValid == /\ phase \in {"valid", "invalid"} /\ phase' = "valid" /\ draft' = 1 /\ UNCHANGED stored
EditInvalid == /\ phase \in {"valid", "invalid"} /\ phase' = "invalid" /\ draft' = 2 /\ UNCHANGED stored
Reset == /\ phase' = "valid" /\ draft' = 0 /\ UNCHANGED stored
Next == EditValid \/ EditInvalid \/ Reset
MemoryOnly == stored = 0
ValidResults == phase = "valid" => draft \in {0,1}
InvalidRefuses == phase = "invalid" => draft = 2
=============================================================================
