---- MODULE Switcher ----
EXTENDS FiniteSets

VARIABLES session, results, pending, available, shown
vars == <<session, results, pending, available, shown>>
Sources == {"board", "network", "inbox"}
TypeOK == /\ session \in {"SignedIn", "Retired"}
          /\ results \in {"Closed", "Loading", "Partial", "Ready"}
          /\ pending \subseteq Sources
          /\ available \subseteq Sources
          /\ shown \subseteq Sources
Init == /\ session = "SignedIn" /\ results = "Closed"
        /\ pending = {} /\ available = {} /\ shown = {}

\* js/app-shell.js:44 fences retired actors before opening.
Open == /\ session = "SignedIn" /\ results = "Closed"
        /\ results' = "Loading" /\ pending' = Sources
        /\ available' = {} /\ shown' = {} /\ UNCHANGED session

\* src/ui/quick-switcher.tsx:158-162 publishes each settled source.
\* src/ui/quick-switcher.tsx:271 admits only the current request.
SourceSettles(source, success) ==
    /\ results # "Closed" /\ source \in pending
    /\ pending' = pending \ {source}
    /\ available' = IF success THEN available \cup {source} ELSE available
    /\ shown' = available'
    /\ results' = IF pending' = {} THEN "Ready" ELSE "Partial"
    /\ UNCHANGED session

\* src/ui/quick-switcher.tsx:286-288 retires the old effect on Retry.
Retry == /\ results \in {"Partial", "Ready"}
         /\ results' = "Loading" /\ pending' = Sources
         /\ available' = {} /\ shown' = {} /\ UNCHANGED session

\* src/ui/quick-switcher.tsx:205-211 unmounts the effect on close.
Close == /\ results # "Closed" /\ results' = "Closed"
         /\ pending' = {} /\ available' = {} /\ shown' = {}
         /\ UNCHANGED session

\* src/ui/quick-switcher.tsx:216-219 closes on actor invalidation.
SessionEnds == /\ session = "SignedIn" /\ session' = "Retired"
               /\ results' = "Closed" /\ pending' = {}
               /\ available' = {} /\ shown' = {}
Next == Open \/ Retry \/ Close \/ SessionEnds
        \/ (\E source \in Sources, success \in BOOLEAN: SourceSettles(source, success))
Spec == Init /\ [][Next]_vars

\* A retired actor sees no private results and starts no read.
NoRetiredResults == ~(session = "Retired" /\ results \in {"Partial", "Ready"})
NoRetiredRead == ~(session = "Retired" /\ results = "Loading")
\* A pending Home read never hides available deals or contacts.
PendingInboxPreservesResults ==
    (results # "Closed" /\ "inbox" \in pending) => (available \subseteq shown)
====
