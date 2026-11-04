---------------------------- MODULE Upload ----------------------------
EXTENDS Naturals
VARIABLES receipt, commitSent, confirmed, bytes
vars == <<receipt, commitSent, confirmed, bytes>>
Init == /\ receipt = "none" /\ commitSent = FALSE /\ confirmed = FALSE /\ bytes = TRUE
Reserve == /\ receipt = "none" /\ receipt' = "reserved" /\ UNCHANGED <<commitSent,confirmed,bytes>>
Receive == /\ receipt = "reserved" /\ receipt' = "receiving" /\ UNCHANGED <<commitSent,confirmed,bytes>>
Stage == /\ receipt \in {"receiving","retryable_unknown"} /\ receipt' = "staged" /\ UNCHANGED <<commitSent,confirmed,bytes>>
Unknown == /\ receipt = "receiving" /\ receipt' = "retryable_unknown" /\ UNCHANGED <<commitSent,confirmed,bytes>>
Reject == /\ receipt = "receiving" /\ receipt' = "rejected" /\ UNCHANGED <<commitSent,confirmed,bytes>>
File == /\ receipt = "staged" /\ receipt' = "filed" /\ commitSent' = TRUE /\ UNCHANGED <<confirmed,bytes>>
Readback == /\ receipt = "filed" /\ confirmed' = TRUE /\ bytes' = FALSE /\ UNCHANGED <<receipt,commitSent>>
Cancel == /\ receipt \in {"none","reserved","staged","rejected"} /\ receipt' = "cancelled" /\ bytes' = FALSE /\ UNCHANGED <<commitSent,confirmed>>
Expire == /\ receipt \notin {"filed","cancelled","expired"} /\ receipt' = "expired" /\ UNCHANGED <<commitSent,confirmed,bytes>>
CheckAgain == UNCHANGED vars
Next == Reserve \/ Receive \/ Stage \/ Unknown \/ Reject \/ File \/ Readback \/ Cancel \/ Expire \/ CheckAgain
CommitOnlyStaged == commitSent => receipt = "filed"
ConfirmOnlyFiled == confirmed => receipt = "filed"
KeepBytesUntilResolution == ~bytes => (confirmed \/ receipt = "cancelled")
=====================================================================
