---- MODULE Freeze ----
EXTENDS Naturals
VARIABLES selection, insertion, scope, stored, snapshot, draft, body, key, frozenBody, frozenKey, outbox, lock, checked
vars == <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox,lock,checked>>
Init == /\ selection = "None" /\ insertion = "Reviewing" /\ scope = "Verified"
        /\ stored = "Existing" /\ snapshot = "Existing" /\ draft = "Existing"
        /\ body = "" /\ key = 0 /\ frozenBody = "" /\ frozenKey = 0 /\ outbox = "Draft" /\ lock = "Free" /\ checked = FALSE
SelectLines == /\ scope = "Verified" /\ selection' = "Selected" /\ insertion' = "Reviewing"
               /\ UNCHANGED <<scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox,lock,checked>>
AddComment == /\ selection = "Selected" /\ selection' = "Commented"
              /\ UNCHANGED <<insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox,lock,checked>>
ReplaceSource == /\ selection' = "None" /\ insertion' = "Reviewing"
                 /\ UNCHANGED <<scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox,lock,checked>>
UseInNextAsk == /\ selection # "None" /\ scope = "Verified" /\ insertion \in {"Reviewing","Failed"}
                /\ insertion' = "Inserting"
                /\ UNCHANGED <<selection,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox,lock,checked>>
AnotherTabEdits == /\ lock = "Free" /\ stored' = "Other tab"
                   /\ UNCHANGED <<selection,insertion,scope,snapshot,draft,body,key,frozenBody,frozenKey,outbox,lock,checked>>
\* queued-asks.ts: draft mutation callback holds the named exclusive lock.
AcquireDraft == /\ insertion = "Inserting" /\ lock = "Free" /\ lock' = "Quote"
                /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox,checked>>
\* queued-asks.ts: appendDraft compares snapshot and displayed expected text.
CheckDraft == /\ lock = "Quote" /\ ~checked /\ scope = "Verified" /\ stored = snapshot
              /\ checked' = TRUE
              /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox,lock>>
\* queued-asks.ts: setItem is a separate operation under the same lock.
SaveDraft == /\ insertion = "Inserting" /\ lock = "Quote" /\ checked /\ scope = "Verified"
             /\ insertion' = "Inserted" /\ stored' = "Existing plus quote" /\ snapshot' = stored' /\ draft' = stored'
             /\ lock' = "Free" /\ checked' = FALSE
             /\ UNCHANGED <<selection,scope,body,key,frozenBody,frozenKey,outbox>>
ReleaseDraft == /\ lock = "Quote" /\ lock' = "Free" /\ checked' = FALSE /\ insertion' = "Failed"
                /\ UNCHANGED <<selection,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox>>
StorageFailure == /\ insertion = "Inserting" /\ insertion' = "Failed"
                  /\ UNCHANGED <<selection,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox,lock,checked>>
RetireSession == /\ scope' = "Retired" /\ selection' = "None" /\ insertion' = "Unavailable"
                 /\ UNCHANGED <<stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox,lock,checked>>
ReopenDraft == /\ lock = "Free" /\ scope = "Verified" /\ insertion' = "Reviewing" /\ snapshot' = stored /\ draft' = stored
               /\ UNCHANGED <<selection,scope,stored,body,key,frozenBody,frozenKey,outbox,lock,checked>>
SendAsk == /\ scope = "Verified" /\ draft = stored /\ outbox = "Draft"
           /\ body' = draft /\ frozenBody' = draft /\ key' = 1 /\ frozenKey' = 1 /\ outbox' = "Queued"
           /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,lock,checked>>
Reconnect == /\ outbox \in {"Queued","Unknown"} /\ outbox' = "Submitting"
             /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,lock,checked>>
Refuse == /\ outbox = "Submitting" /\ outbox' = "Refused"
          /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,lock,checked>>
Unknown == /\ outbox = "Submitting" /\ outbox' = "Unknown"
           /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,lock,checked>>
Accept == /\ outbox = "Submitting" /\ outbox' = "Accepted"
          /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,lock,checked>>
Retry == /\ outbox = "Refused" /\ outbox' = "Submitting"
         /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,lock,checked>>
Reload == UNCHANGED vars
Next == SelectLines \/ AddComment \/ ReplaceSource \/ UseInNextAsk \/ AnotherTabEdits \/ AcquireDraft \/ CheckDraft \/ ReleaseDraft \/ SaveDraft \/ StorageFailure \/ RetireSession \/ ReopenDraft \/ SendAsk \/ Reconnect \/ Refuse \/ Unknown \/ Accept \/ Retry \/ Reload
Spec == Init /\ [][Next]_vars
\* A retired session can never insert into a conversation.
NoCrossScope == scope = "Retired" => ~ENABLED UseInNextAsk
\* A changed device draft can never be overwritten by insertion.
NoConcurrentOverwrite == checked => stored = snapshot
\* Sending and retrying can never change the accepted body.
NoFrozenMutation == outbox # "Draft" => body = frozenBody
\* Retrying can never regenerate a request key.
NoRegeneratedKey == outbox # "Draft" => key = frozenKey
====
