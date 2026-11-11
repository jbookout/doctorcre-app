---- MODULE IntroductionRequest ----
EXTENDS Naturals
VARIABLE s
vars == <<s>>
Phases == {"selected", "reviewing", "submitting", "refused", "unknown", "confirmed", "changed_source", "retired"}
Openable == {"selected", "reviewing", "refused", "confirmed", "changed_source"}

\* One endpoint triple, two intended requests and two network attempts.
\* The deployed link-parties contract supplies same-key replay and unique links.
\* Exact identity, date and note comparisons are abstracted by matching readback.
\* Freshness is read evidence, not instantaneous server state; no atomic fence is claimed.
\* External source inputs are nondeterministic at open, preflight and readback.
Init == s = [phase |-> "selected", reviewed |-> FALSE, fresh |-> TRUE,
  key |-> 0, seq |-> 0, original |-> 0, unresolved |-> FALSE,
  validated |-> FALSE, sent |-> FALSE, receipt |-> FALSE, readback |-> FALSE, matches |-> FALSE, originalFresh |-> FALSE,
  attempts |-> 0, writes |-> 0, retiredAt |-> 0,
  lastReview |-> FALSE, lastFresh |-> FALSE, private |-> FALSE]

TypeOK == /\ s.phase \in Phases
  /\ s.key \in 0..2 /\ s.seq \in 0..2 /\ s.original \in 0..2
  /\ s.attempts \in 0..2 /\ s.writes \in 0..1 /\ s.retiredAt \in 0..2
  /\ \A flag \in {"reviewed", "fresh", "unresolved", "validated", "sent", "receipt", "readback", "matches", "originalFresh", "lastReview", "lastFresh", "private"}: s[flag] \in BOOLEAN

\* A person must review the path before a request is dispatched.
NoUnreviewedDispatch == s.attempts = 0 \/ s.lastReview
\* A dispatch must use a verified source or the retained verified request.
NoUncheckedDispatch == s.attempts = 0 \/ s.lastFresh
\* An unknown request cannot be replaced with a new safety key.
NoNewKeyWhileUnknown == s.unresolved => s.key = s.original
\* A recorded status needs both a receipt and exact canonical readback.
NoUnverifiedConfirmation == s.phase = "confirmed" => s.receipt /\ s.readback /\ s.matches
\* Ending a session prevents any subsequent dispatch.
NoDispatchAfterRetirement == s.phase = "retired" => s.attempts = s.retiredAt
\* Ending a session removes the private review and retained request.
NoPrivateViewAfterRetirement == s.phase = "retired" => ~s.private /\ s.key = 0

Open ==
  /\ s.phase \in Openable \* src/ui/introduction-request.ts:355
  /\ s' = [s EXCEPT !.phase = "reviewing", !.reviewed = FALSE, !.key = 0,
       !.private = TRUE, !.receipt = FALSE, !.readback = FALSE, !.fresh = TRUE]
OpenUnavailable ==
  /\ s.phase \in Openable \* src/ui/introduction-request.ts:355
  /\ s' = [s EXCEPT !.phase = "changed_source", !.fresh = FALSE]
Review ==
  /\ s.phase = "reviewing" \* src/ui/introduction-request.ts:109
  /\ s' = [s EXCEPT !.reviewed = ~@]
Prepare ==
  /\ s.phase = "reviewing" \* src/ui/introduction-request.ts:368
  /\ s.reviewed \* src/ui/introduction-request.ts:370
  /\ s.seq < 2 \* finite model bound, not a runtime retry limit
  /\ \E available \in BOOLEAN:
       s' = [s EXCEPT !.phase = "submitting", !.seq = @ + 1, !.key = s.seq + 1,
         !.validated = FALSE, !.sent = FALSE, !.receipt = FALSE, !.readback = FALSE, !.fresh = available]
Validate ==
  /\ s.phase = "submitting" /\ ~s.sent /\ ~s.unresolved \* src/ui/introduction-request.ts:294
  /\ s.fresh /\ s.writes = 0 \* src/ui/introduction-request.ts:296
  /\ s' = [s EXCEPT !.validated = TRUE]
InvalidSource ==
  /\ s.phase = "submitting" /\ ~s.sent /\ ~s.unresolved \* src/ui/introduction-request.ts:294
  /\ (~s.fresh \/ s.writes = 1) \* src/ui/introduction-request.ts:296
  /\ s' = [s EXCEPT !.phase = "changed_source"]
Send ==
  /\ s.phase = "submitting" /\ s.validated /\ ~s.sent \* src/ui/introduction-request.ts:307
  /\ s.attempts < 2 \* finite model bound, not a runtime retry limit
  /\ \E committed \in {s.writes, 1}:
       s' = [s EXCEPT !.sent = TRUE, !.attempts = @ + 1, !.writes = committed,
           !.lastReview = s.reviewed, !.lastFresh = IF s.unresolved THEN s.originalFresh ELSE s.fresh /\ s.writes = 0]
Refuse ==
  /\ s.phase = "submitting" /\ s.sent /\ s.writes = 0 \* src/ui/introduction-request.ts:344
  /\ s' = [s EXCEPT !.phase = "refused", !.unresolved = FALSE, !.sent = FALSE]
LoseResponse ==
  /\ s.phase = "submitting" /\ s.sent \* src/ui/introduction-request.ts:345
  /\ s' = [s EXCEPT !.phase = "unknown", !.original = s.key,
       !.unresolved = TRUE, !.sent = FALSE, !.readback = FALSE, !.originalFresh = s.lastFresh]
Receipt ==
  /\ s.phase = "submitting" /\ s.sent /\ s.writes = 1 /\ ~s.receipt \* src/ui/introduction-request.ts:307
  /\ \E available, matching \in BOOLEAN: s' = [s EXCEPT !.receipt = TRUE, !.fresh = available, !.matches = matching]
MatchingReadback ==
  /\ s.phase = "submitting" /\ s.receipt /\ s.fresh \* src/ui/introduction-request.ts:309
  /\ s.writes = 1 /\ s.matches \* src/ui/introduction-request.ts:316
  /\ s' = [s EXCEPT !.phase = "confirmed", !.readback = TRUE, !.unresolved = FALSE]
Recover ==
  /\ s.phase = "unknown" /\ s.unresolved \* src/ui/introduction-request.ts:393
  /\ s' = [s EXCEPT !.phase = "submitting", !.sent = FALSE, !.receipt = FALSE, !.readback = FALSE]
Retire ==
  /\ s.phase # "retired" \* src/ui/introduction-request.ts:279
  /\ s' = [s EXCEPT !.phase = "retired", !.private = FALSE, !.key = 0,
       !.unresolved = FALSE, !.retiredAt = s.attempts]

Next == Open \/ OpenUnavailable \/ Review \/ Prepare \/ Validate \/ InvalidSource
  \/ Send \/ Refuse \/ LoseResponse \/ Receipt \/ MatchingReadback \/ Recover \/ Retire
Spec == Init /\ [][Next]_vars
====
