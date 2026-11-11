---- MODULE BoundReview ----
EXTENDS Naturals
VARIABLES phase, property, pendingProperty, visibleProperty, retainedKey
vars == <<phase, property, pendingProperty, visibleProperty, retainedKey>>
Init == /\ phase = "comparing" /\ property = 1 /\ pendingProperty = 0 /\ visibleProperty = 1 /\ retainedKey = 0
Read == /\ phase \in {"comparing", "refused", "unavailable"}
        /\ phase' = "reading" /\ pendingProperty' = property /\ visibleProperty' = 0
        /\ UNCHANGED <<property,retainedKey>>
Select == /\ phase \in {"comparing", "reading", "refused", "unavailable"}
          /\ property' = 3-property /\ phase' = "comparing" /\ pendingProperty' = 0
          /\ visibleProperty'=3-property /\ UNCHANGED retainedKey
Arrive == /\ phase="reading" /\ pendingProperty=property
          /\ phase'="comparing" /\ visibleProperty'=property
          /\ UNCHANGED <<property,pendingProperty,retainedKey>>
ReadFails == /\ phase="reading" /\ phase'="unavailable"
             /\ UNCHANGED <<property,pendingProperty,visibleProperty,retainedKey>>
Late == UNCHANGED vars
Submit == /\ phase \in {"comparing","refused"} /\ phase'="reviewing" /\ retainedKey'=1
          /\ UNCHANGED <<property,pendingProperty,visibleProperty>>
Unknown == /\ phase="reviewing" /\ phase'="unknown" /\ UNCHANGED <<property,pendingProperty,visibleProperty,retainedKey>>
Retry == /\ phase="unknown" /\ retainedKey=1 /\ phase'="reviewing"
         /\ UNCHANGED <<property,pendingProperty,visibleProperty,retainedKey>>
Refuse == /\ phase="reviewing" /\ phase'="refused" /\ retainedKey'=0 /\ UNCHANGED <<property,pendingProperty,visibleProperty>>
Confirm == /\ phase="reviewing" /\ phase'="reading" /\ retainedKey'=0 /\ pendingProperty'=property /\ visibleProperty'=0 /\ UNCHANGED property
Retire == /\ phase'="retired" /\ visibleProperty'=0 /\ retainedKey'=0 /\ UNCHANGED <<property,pendingProperty>>
Next == Read \/ ReadFails \/ Select \/ Arrive \/ Late \/ Submit \/ Unknown \/ Retry \/ Refuse \/ Confirm \/ Retire
Spec == Init /\ [][Next]_vars
NoCrossProperty == visibleProperty=0 \/ visibleProperty=property
NoRetiredEvidence == phase="retired" => visibleProperty=0
UnknownRetainsKey == phase="unknown" => retainedKey=1
====
