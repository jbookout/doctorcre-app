---- MODULE Waiting ----
EXTENDS Naturals
VARIABLES phase, draft, key, sentKey, shown
vars == <<phase, draft, key, sentKey, shown>>
Init == /\ phase = "Closed" /\ draft = FALSE /\ key = 0 /\ sentKey = 0 /\ shown = FALSE
Edit == /\ phase = "Closed" /\ phase' = "Editing" /\ draft' = TRUE /\ UNCHANGED <<key, sentKey, shown>>
Send == /\ phase = "Editing" /\ phase' = "Sending" /\ key' = 1 /\ sentKey' = 1 /\ UNCHANGED <<draft, shown>>
Conflict == /\ phase = "Sending" /\ phase' = "Conflict" /\ UNCHANGED <<draft, key, sentKey, shown>>
Refresh == /\ phase = "Conflict" /\ phase' = "Editing" /\ UNCHANGED <<draft, key, sentKey, shown>>
Uncertain == /\ phase = "Sending" /\ phase' = "Uncertain" /\ UNCHANGED <<draft, key, sentKey, shown>>
Retry == /\ phase = "Uncertain" /\ phase' = "Sending" /\ UNCHANGED <<draft, key, sentKey, shown>>
Readback == /\ phase = "Sending" /\ phase' = "Confirmed" /\ shown' = TRUE /\ UNCHANGED <<draft, key, sentKey>>
Finish == /\ phase = "Confirmed" /\ phase' = "Settled" /\ shown' = FALSE /\ UNCHANGED <<draft, key, sentKey>>
Stay == UNCHANGED vars
Next == Edit \/ Send \/ Conflict \/ Refresh \/ Uncertain \/ Retry \/ Readback \/ Finish \/ Stay
DraftKept == phase \in {"Conflict", "Uncertain"} => draft
SameKey == phase \in {"Sending", "Uncertain"} => key = sentKey
VerifiedDisplay == shown => phase = "Confirmed"
Spec == Init /\ [][Next]_vars
====
