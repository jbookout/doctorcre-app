---- MODULE TourList ----
EXTENDS TLC, Integers
VARIABLE phase, private, request, route, host
vars == <<phase, private, request, route, host>>
Init == /\ route = "tour-list" /\ host = 0 /\ phase = "loading" /\ private = FALSE /\ request = FALSE
Read == /\ phase \in {"loading", "unavailable"} /\ phase' \in {"ready", "unavailable"} /\ private' = (phase' = "ready") /\ UNCHANGED request /\ UNCHANGED <<route, host>>
Edit == /\ phase = "ready" /\ phase' = "dirty" /\ UNCHANGED <<private, request>> /\ UNCHANGED <<route, host>>
Save == /\ phase = "dirty" /\ phase' = "saving" /\ request' = TRUE /\ UNCHANGED private /\ UNCHANGED <<route, host>>
Receipt == /\ phase = "saving" /\ phase' \in {"ready", "conflict", "uncertain"} /\ request' = (phase' = "uncertain") /\ UNCHANGED private /\ UNCHANGED <<route, host>>
Retry == /\ phase = "uncertain" /\ phase' = "saving" /\ UNCHANGED <<private, request>> /\ UNCHANGED <<route, host>>
Reload == /\ phase \in {"ready", "dirty", "conflict"} /\ phase' = "loading" /\ private' = FALSE /\ request' = FALSE /\ UNCHANGED <<route, host>>
Logout == /\ phase \notin {"expired", "disposed", "signing-out"} /\ phase' = "signing-out" /\ private' = FALSE /\ request' = FALSE /\ UNCHANGED <<route, host>>
LogoutFailure == /\ phase = "signing-out" /\ phase' = "signout-uncertain" /\ UNCHANGED <<private, request>> /\ UNCHANGED <<route, host>>
Retire == /\ phase # "disposed" /\ phase' \in {"expired", "disposed"} /\ private' = FALSE /\ request' = FALSE /\ UNCHANGED <<route, host>>
Stay == UNCHANGED vars
RouteSwitch == /\ route' \in {"home", "tour-list"} /\ UNCHANGED <<phase, private, request, host>>
HostSwitch == /\ host' = 1 - host /\ phase' = "loading" /\ private' = FALSE /\ request' = FALSE /\ UNCHANGED route
Next == RouteSwitch \/ HostSwitch \/ Read \/ Edit \/ Save \/ Receipt \/ Retry \/ Reload \/ Logout \/ LogoutFailure \/ Retire \/ Stay
NoRetiredPrivate == phase \in {"expired", "disposed", "signing-out", "signout-uncertain"} => ~private
UncertainKeepsRequest == phase = "uncertain" => request
Spec == Init /\ [][Next]_vars
====
