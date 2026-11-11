---- MODULE BoundReview ----
EXTENDS Naturals
VARIABLES phase, property, pendingProperty, visibleProperty, retainedKey, snapshots, visibleVersion, freshest
vars == <<phase, property, pendingProperty, visibleProperty, retainedKey, snapshots, visibleVersion, freshest>>
Init == /\ phase = "comparing" /\ property = 1 /\ pendingProperty = 0 /\ visibleProperty = 1 /\ retainedKey = 0
        /\ snapshots = [p \in 1..2 |-> 0] /\ freshest = [p \in 1..2 |-> 0] /\ visibleVersion = 0
Read == /\ phase \in {"comparing", "refused", "unavailable"}
        /\ phase' = "reading" /\ pendingProperty' = property /\ visibleProperty' = 0
        /\ UNCHANGED <<property,retainedKey,snapshots,visibleVersion,freshest>>
\* src/ui/tour-coordinate-review.ts:224-233 select() reads snapshots, never options.stops.
Select == /\ phase \in {"comparing", "reading", "refused", "unavailable"}
          /\ property' = 3-property /\ phase' = "comparing" /\ pendingProperty' = 0
          /\ visibleProperty'=3-property /\ visibleVersion'=snapshots[3-property]
          /\ UNCHANGED <<retainedKey,snapshots,freshest>>
\* src/ui/tour-coordinate-review-model.ts:154-158 refresh() admits as_of >= latestAsOf.
Arrive == /\ phase="reading" /\ pendingProperty=property
          /\ phase'="comparing" /\ visibleProperty'=property
          /\ \E version \in snapshots[property]..2:
              /\ snapshots' = [snapshots EXCEPT ![property] = version]
              /\ freshest' = [freshest EXCEPT ![property] = IF version > @ THEN version ELSE @]
              /\ visibleVersion' = version
          /\ UNCHANGED <<property,pendingProperty,retainedKey>>
ReadFails == /\ phase="reading" /\ phase'="unavailable"
             /\ UNCHANGED <<property,pendingProperty,visibleProperty,retainedKey,snapshots,visibleVersion,freshest>>
Late == UNCHANGED vars
Submit == /\ phase \in {"comparing","refused"} /\ phase'="reviewing" /\ retainedKey'=1
          /\ UNCHANGED <<property,pendingProperty,visibleProperty,snapshots,visibleVersion,freshest>>
Unknown == /\ phase="reviewing" /\ phase'="unknown" /\ UNCHANGED <<property,pendingProperty,visibleProperty,retainedKey,snapshots,visibleVersion,freshest>>
Retry == /\ phase="unknown" /\ retainedKey=1 /\ phase'="reviewing"
         /\ UNCHANGED <<property,pendingProperty,visibleProperty,retainedKey,snapshots,visibleVersion,freshest>>
Refuse == /\ phase="reviewing" /\ phase'="refused" /\ retainedKey'=0 /\ UNCHANGED <<property,pendingProperty,visibleProperty,snapshots,visibleVersion,freshest>>
Confirm == /\ phase="reviewing" /\ phase'="reading" /\ retainedKey'=0 /\ pendingProperty'=property /\ visibleProperty'=0 /\ UNCHANGED <<property,snapshots,visibleVersion,freshest>>
Retire == /\ phase'="retired" /\ visibleProperty'=0 /\ retainedKey'=0 /\ UNCHANGED <<property,pendingProperty,snapshots,visibleVersion,freshest>>
Next == Read \/ ReadFails \/ Select \/ Arrive \/ Late \/ Submit \/ Unknown \/ Retry \/ Refuse \/ Confirm \/ Retire
Spec == Init /\ [][Next]_vars
NoCrossProperty == visibleProperty=0 \/ visibleProperty=property
NoRetiredEvidence == phase="retired" => visibleProperty=0
UnknownRetainsKey == phase="unknown" => retainedKey=1
\* Selection must display the freshest producer snapshot retained for that property.
SelectionNeverRegresses == visibleProperty # 0 => visibleVersion = freshest[property]
\* Refresh may only advance a property's producer version.
SnapshotsNeverRegress == \A p \in 1..2: snapshots[p] = freshest[p]
====

