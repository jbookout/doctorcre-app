--------------------------- MODULE Picker ---------------------------
EXTENDS Naturals
VARIABLES generation, active, request, shown
vars == <<generation, active, request, shown>>
Init == generation = 0 /\ active = FALSE /\ request = 0 /\ shown = 0
Type == generation \in 0..2 /\ request \in 0..2 /\ shown \in 0..2 /\ active \in BOOLEAN
Fresh == shown = 0 \/ shown = generation
Input == generation < 2 /\ generation' = generation + 1 /\ shown' = 0 /\ UNCHANGED <<active, request>>
Start == ~active /\ generation > 0 /\ active' = TRUE /\ request' = generation /\ UNCHANGED <<generation, shown>>
Finish == active /\ active' = FALSE /\ shown' = (IF request = generation THEN request ELSE shown) /\ UNCHANGED <<generation, request>>
Done == UNCHANGED vars
Next == Input \/ Start \/ Finish \/ Done
=====================================================================
