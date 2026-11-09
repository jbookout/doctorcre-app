---- MODULE Freeze ----
EXTENDS Naturals
VARIABLES selection, insertion, scope, stored, snapshot, draft, body, key, frozenBody, frozenKey, outbox
vars == <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox>>
Init == /\ selection = "None" /\ insertion = "Reviewing" /\ scope = "Verified"
        /\ stored = "Existing" /\ snapshot = "Existing" /\ draft = "Existing"
        /\ body = "" /\ key = 0 /\ frozenBody = "" /\ frozenKey = 0 /\ outbox = "Draft"
SelectLines == /\ scope = "Verified" /\ selection' = "Selected" /\ insertion' = "Reviewing"
               /\ UNCHANGED <<scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox>>
AddComment == /\ selection = "Selected" /\ selection' = "Commented"
              /\ UNCHANGED <<insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox>>
ReplaceSource == /\ selection' = "None" /\ insertion' = "Reviewing"
                 /\ UNCHANGED <<scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox>>
UseInNextAsk == /\ selection # "None" /\ scope = "Verified" /\ insertion \in {"Reviewing","Failed"}
                /\ insertion' = "Inserting"
                /\ UNCHANGED <<selection,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox>>
AnotherTabEdits == /\ stored' = "Other tab"
                   /\ UNCHANGED <<selection,insertion,scope,snapshot,draft,body,key,frozenBody,frozenKey,outbox>>
SaveDraft == /\ insertion = "Inserting" /\ scope = "Verified" /\ stored = snapshot
             /\ insertion' = "Inserted" /\ stored' = "Existing plus quote" /\ snapshot' = stored' /\ draft' = stored'
             /\ UNCHANGED <<selection,scope,body,key,frozenBody,frozenKey,outbox>>
StorageFailure == /\ insertion = "Inserting" /\ insertion' = "Failed"
                  /\ UNCHANGED <<selection,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox>>
RetireSession == /\ scope' = "Retired" /\ selection' = "None" /\ insertion' = "Unavailable"
                 /\ UNCHANGED <<stored,snapshot,draft,body,key,frozenBody,frozenKey,outbox>>
ReopenDraft == /\ scope = "Verified" /\ insertion' = "Reviewing" /\ snapshot' = stored /\ draft' = stored
               /\ UNCHANGED <<selection,scope,stored,body,key,frozenBody,frozenKey,outbox>>
SendAsk == /\ scope = "Verified" /\ draft = stored /\ outbox = "Draft"
           /\ body' = draft /\ frozenBody' = draft /\ key' = 1 /\ frozenKey' = 1 /\ outbox' = "Queued"
           /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft>>
Reconnect == /\ outbox \in {"Queued","Unknown"} /\ outbox' = "Submitting"
             /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey>>
Refuse == /\ outbox = "Submitting" /\ outbox' = "Refused"
          /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey>>
Unknown == /\ outbox = "Submitting" /\ outbox' = "Unknown"
           /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey>>
Accept == /\ outbox = "Submitting" /\ outbox' = "Accepted"
          /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey>>
Retry == /\ outbox = "Refused" /\ outbox' = "Submitting"
         /\ UNCHANGED <<selection,insertion,scope,stored,snapshot,draft,body,key,frozenBody,frozenKey>>
Reload == UNCHANGED vars
Next == SelectLines \/ AddComment \/ ReplaceSource \/ UseInNextAsk \/ AnotherTabEdits \/ SaveDraft \/ StorageFailure \/ RetireSession \/ ReopenDraft \/ SendAsk \/ Reconnect \/ Refuse \/ Unknown \/ Accept \/ Retry \/ Reload
Spec == Init /\ [][Next]_vars
\* A retired session can never insert into a conversation.
NoCrossScope == scope = "Retired" => ~ENABLED UseInNextAsk
\* A changed device draft can never be overwritten by insertion.
NoConcurrentOverwrite == stored # snapshot => ~ENABLED SaveDraft
\* Sending and retrying can never change the accepted body.
NoFrozenMutation == outbox # "Draft" => body = frozenBody
\* Retrying can never regenerate a request key.
NoRegeneratedKey == outbox # "Draft" => key = frozenKey
====
