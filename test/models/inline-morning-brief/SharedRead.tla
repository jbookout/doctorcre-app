---- MODULE SharedRead ----
EXTENDS Integers
VARIABLES epoch, pending, shown
vars == <<epoch, pending, shown>>
Init == epoch = 0 /\ pending = -1 /\ shown = -1
Read == pending = -1 /\ pending' = epoch /\ UNCHANGED <<epoch, shown>>
Accept == pending # -1 /\ shown' = (IF pending = epoch THEN epoch ELSE shown)
          /\ pending' = -1 /\ UNCHANGED epoch
Fail == pending # -1 /\ shown' = (IF pending = epoch THEN -1 ELSE shown)
        /\ pending' = -1 /\ UNCHANGED epoch
Retire == epoch = 0 /\ epoch' = 1 /\ shown' = -1 /\ UNCHANGED pending
Next == Read \/ Accept \/ Fail \/ Retire
TypeOK == epoch \in {0, 1} /\ pending \in {-1, 0, 1} /\ shown \in {-1, 0, 1}
PrivateFactsCurrent == shown = -1 \/ shown = epoch
Spec == Init /\ [][Next]_vars
====
