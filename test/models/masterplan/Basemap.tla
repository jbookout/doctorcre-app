----------------------------- MODULE Basemap -----------------------------
EXTENDS Naturals
VARIABLES phase, rights, overlay, camera, selection
vars == <<phase, rights, overlay, camera, selection>>
Init == /\ phase = "local" /\ rights = FALSE /\ overlay = TRUE /\ camera = 7 /\ selection = "property-1"
Authorize == /\ phase = "local" /\ rights' = TRUE /\ UNCHANGED <<phase, overlay, camera, selection>>
Load == /\ phase = "local" /\ rights /\ phase' = "loading" /\ UNCHANGED <<rights, overlay, camera, selection>>
Ready == /\ phase = "loading" /\ phase' = "vector" /\ UNCHANGED <<rights, overlay, camera, selection>>
Fail == /\ phase \in {"local", "loading", "vector"} /\ phase' = "fallback" /\ UNCHANGED <<rights, overlay, camera, selection>>
Local == /\ phase \in {"loading", "vector", "fallback"} /\ phase' = "local" /\ UNCHANGED <<rights, overlay, camera, selection>>
Toggle == /\ phase # "disposed" /\ overlay' = ~overlay /\ UNCHANGED <<phase, rights, camera, selection>>
Dispose == /\ phase # "disposed" /\ phase' = "disposed" /\ UNCHANGED <<rights, overlay, camera, selection>>
Done == /\ phase = "disposed" /\ UNCHANGED vars
Next == Authorize \/ Load \/ Ready \/ Fail \/ Local \/ Toggle \/ Dispose \/ Done
StableContext == camera = 7 /\ selection = "property-1"
Licensed == phase \in {"loading", "vector"} => rights
=============================================================================
