---------------------------- MODULE Share ----------------------------
EXTENDS Naturals
VARIABLES phase, bytes, actor, selected, reserved, confirmed
vars == <<phase, bytes, actor, selected, reserved, confirmed>>
Init == /\ phase = "incoming" /\ bytes = FALSE /\ actor = FALSE /\ selected = 0 /\ reserved = 0 /\ confirmed = FALSE
Stage == /\ phase = "incoming" /\ phase' = "locally_staged" /\ bytes' = TRUE /\ UNCHANGED <<actor,selected,reserved,confirmed>>
Authenticate == /\ phase = "locally_staged" /\ phase' = "authenticating" /\ UNCHANGED <<bytes,actor,selected,reserved,confirmed>>
Bind == /\ phase = "authenticating" /\ phase' = "choosing_deal" /\ actor' = TRUE /\ UNCHANGED <<bytes,selected,reserved,confirmed>>
Choose == /\ phase \in {"choosing_deal","ready"} /\ phase' = "ready" /\ selected' \in {1,2} /\ reserved' = 0 /\ UNCHANGED <<bytes,actor,confirmed>>
Reserve == /\ phase = "ready" /\ phase' = "reserving" /\ reserved' = selected /\ UNCHANGED <<bytes,actor,selected,confirmed>>
Upload == /\ phase = "reserving" /\ phase' = "uploading" /\ UNCHANGED <<bytes,actor,selected,reserved,confirmed>>
Commit == /\ phase = "uploading" /\ phase' = "committing" /\ UNCHANGED <<bytes,actor,selected,reserved,confirmed>>
Unknown == /\ phase \in {"reserving","uploading","committing"} /\ phase' = "unknown_outcome" /\ UNCHANGED <<bytes,actor,selected,reserved,confirmed>>
Reconcile == /\ phase = "unknown_outcome" /\ phase' = "committing" /\ UNCHANGED <<bytes,actor,selected,reserved,confirmed>>
Readback == /\ phase = "committing" /\ phase' = "filed" /\ confirmed' = TRUE /\ bytes' = FALSE /\ UNCHANGED <<actor,selected,reserved>>
Quota == /\ phase = "locally_staged" /\ phase' = "quota_refused" /\ UNCHANGED <<bytes,actor,selected,reserved,confirmed>>
Cancel == /\ phase \notin {"filed","expired","cancelled"} /\ phase' = "cancelled" /\ bytes' = FALSE /\ UNCHANGED <<actor,selected,reserved,confirmed>>
Expire == /\ phase \notin {"filed","expired","cancelled"} /\ phase' = "expired" /\ bytes' = FALSE /\ UNCHANGED <<actor,selected,reserved,confirmed>>
Done == /\ phase \in {"filed","expired","cancelled"} /\ UNCHANGED vars
Next == Stage \/ Authenticate \/ Bind \/ Choose \/ Reserve \/ Upload \/ Commit \/ Unknown \/ Reconcile \/ Readback \/ Quota \/ Cancel \/ Expire \/ Done
SavedOnlyAfterReadback == phase = "filed" => confirmed
NoUnauthenticatedUpload == phase \in {"reserving","uploading","committing","filed","unknown_outcome"} => actor
SelectedReservation == phase \in {"reserving","uploading","committing","filed","unknown_outcome"} => (reserved = selected /\ selected # 0)
BytesUntilResolution == phase \notin {"incoming","filed","expired","cancelled"} => bytes
=====================================================================
