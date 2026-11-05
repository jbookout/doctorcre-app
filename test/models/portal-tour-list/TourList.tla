---- MODULE TourList ----
EXTENDS TLC
VARIABLE phase, private, request
vars == <<phase, private, request>>
Init == /\ phase = "loading" /\ private = FALSE /\ request = FALSE
Read == /\ phase \in {"loading", "unavailable"} /\ phase' \in {"ready", "unavailable"} /\ private' = (phase' = "ready") /\ UNCHANGED request
Edit == /\ phase = "ready" /\ phase' = "dirty" /\ UNCHANGED <<private, request>>
Save == /\ phase = "dirty" /\ phase' = "saving" /\ request' = TRUE /\ UNCHANGED private
Receipt == /\ phase = "saving" /\ phase' \in {"ready", "conflict", "uncertain"} /\ request' = (phase' = "uncertain") /\ UNCHANGED private
Retry == /\ phase = "uncertain" /\ phase' = "saving" /\ UNCHANGED <<private, request>>
Reload == /\ phase \in {"ready", "dirty", "conflict"} /\ phase' = "loading" /\ private' = FALSE /\ request' = FALSE
Logout == /\ phase \notin {"expired", "disposed", "signing-out"} /\ phase' = "signing-out" /\ private' = FALSE /\ request' = FALSE
LogoutFailure == /\ phase = "signing-out" /\ phase' = "signout-uncertain" /\ UNCHANGED <<private, request>>
Retire == /\ phase # "disposed" /\ phase' \in {"expired", "disposed"} /\ private' = FALSE /\ request' = FALSE
Stay == UNCHANGED vars
Next == Read \/ Edit \/ Save \/ Receipt \/ Retry \/ Reload \/ Logout \/ LogoutFailure \/ Retire \/ Stay
NoRetiredPrivate == phase \in {"expired", "disposed", "signing-out", "signout-uncertain"} => ~private
UncertainKeepsRequest == phase = "uncertain" => request
Spec == Init /\ [][Next]_vars
====
