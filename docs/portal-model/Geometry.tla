----------------------------- MODULE Geometry -----------------------------
EXTENDS Naturals
VARIABLES phase, pending, measured
vars == <<phase, pending, measured>>
Init == /\ phase = "tracking" /\ pending = FALSE /\ measured = FALSE
Event == /\ phase = "tracking" /\ pending' = TRUE /\ UNCHANGED <<phase, measured>>
Measure == /\ phase = "tracking" /\ pending /\ pending' = FALSE /\ measured' = TRUE /\ UNCHANGED phase
Retire == /\ phase = "tracking" /\ phase' = "retired" /\ pending' = FALSE /\ measured' = FALSE
Done == /\ phase = "retired" /\ UNCHANGED vars
Next == Event \/ Measure \/ Retire \/ Done
NoRetiredWrites == phase = "retired" => (~pending /\ ~measured)
=============================================================================
