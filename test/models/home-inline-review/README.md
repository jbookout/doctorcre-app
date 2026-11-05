# Home inline review lifecycle

The chart describes the consumer of CARR home-review.v1 at producer ce0169c9aa7af1c391f9b9376de9145e509c653f. It models browser interactions, not CARR transaction isolation or sender delivery.

The active card stays in its original Home section until Close review. Its displayed canonical fields update after a receipt. This preserves editor focus, edits and confirmation while settlement changes the card placement.

Run `node --test test/home-inline-review.test.mjs test/home-inline-review-browser.test.mjs`.

| Transition | Executed test |
| --- | --- |
| Open, load, ready, edit, save, ready, submit, done, close | inline reply edits, saves and explicitly submits |
| Submission conflict, explicit current-card reload, retained edits, new key | conflict keeps text and reload binds a fresh version |
| Uncertain result, frozen manual replay, saved and ready | uncertain write retries only the identical frozen request |
| Stale, resolved, unsupported, authority refusal, Escape | review safely refuses |
| Submitted authority or resolved refusal | submitted review refuses |
| Unsaved edit, Escape and returned focus without a write | Escape closes unsaved edits without a write and returns focus |
| Unavailable recipients, save or decline, no send | unavailable send recipients preserve Save draft / Decline draft |
| Decline with invalid subject and body, including initially empty body | decline ignores invalid content |
| Save and send require content | save and send still require valid reply content |
| Task completion, exact readback, Undo | task review completes one canonical action |
| Fact approve, correct, reject | fact review calls its existing owner |
| Missing producer reference | older producer without references keeps a navigable card |
| Wrong detail identity, unsupported operation, missing receipt/readback | home-inline-review.test.mjs |

The closing-a-loading-review test exercises Escape and a late response without a domain write. The keyboard test covers keyboard opening, duplicate activation suppression and returned focus. Session invalidation unmounts the entire inbox through its existing owner; the focused suite does not separately exercise session loss during a write.

Fact correction currently uses a document and unit from the displayed observations. With no observed source, or for a rent schedule, correction is disabled just as unsupported correction input must be refused. The existing source record remains available for wider term entry. Production persistence, signed-in authority and email delivery remain unverified locally.

Saving returns directly from Submitting to Ready after the current draft matches its receipt. Conflict reload retains the Conflict editor while loading, then returns to Ready. No Loading transition is claimed for that reload. Loading can close before its detail arrives. These edges map to the save, conflict and closing-a-loading-review browser tests above.
