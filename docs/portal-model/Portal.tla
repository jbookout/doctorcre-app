----------------------------- MODULE Portal -----------------------------
EXTENDS Naturals
VARIABLES phase, visible
vars == <<phase, visible>>
Init == /\ phase = "loading" /\ visible = FALSE
Resolve == /\ phase = "loading" /\ phase' = "ready" /\ visible' = TRUE
Refuse == /\ phase = "loading" /\ phase' = "unavailable" /\ visible' = FALSE
Expire == /\ phase \in {"loading", "ready", "unavailable"} /\ phase' = "expired" /\ visible' = FALSE
Dispose == /\ phase # "disposed" /\ phase' = "disposed" /\ visible' = FALSE
LateResult == /\ phase \in {"expired", "disposed", "unavailable", "ready"} /\ UNCHANGED vars
Next == Resolve \/ Refuse \/ Expire \/ Dispose \/ LateResult
NoRetiredPublication == phase \in {"expired", "disposed", "unavailable", "loading"} => ~visible
ReadyIsVisible == (phase = "ready") = visible
Spec == Init /\ [][Next]_vars
=============================================================================
