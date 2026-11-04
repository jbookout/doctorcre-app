# Home inline review lifecycle

The chart describes the consumer of CARR home-review.v1 at producer ce0169c9aa7af1c391f9b9376de9145e509c653f. It models browser interactions, not CARR transaction isolation or sender delivery.

The active card stays in its original Home section until Close review. Its displayed canonical fields update after a receipt. This preserves editor focus, edits and confirmation while settlement changes the card placement.

Run `node --test test/home-inline-review.test.mjs test/home-inline-review-browser.test.mjs`.

| Transition | Executed test |
| --- | --- |
| Open, load, ready, edit, save, ready, submit, done, close | inline reply edits, saves and explicitly submits |
| Submission conflict, explicit current-card reload, retained edits, new key | conflict keeps text and reload binds a fresh version |
| Uncertain result, frozen manual replay, done | uncertain write retries only the identical frozen request |
| Stale, resolved, unsupported, authority refusal, Escape | review safely refuses |
| Task completion, exact readback, Undo | task review completes one canonical action |
| Fact approve, correct, reject | fact review calls its existing owner |
| Missing producer reference | older producer without references keeps a navigable card |
| Wrong detail identity, unsupported operation, missing receipt/readback | home-inline-review.test.mjs |

The closing-a-loading-review test exercises Escape and a late response without a domain write. The keyboard test covers keyboard opening, duplicate activation suppression and returned focus. Session invalidation unmounts the entire inbox through its existing owner; the focused suite does not separately exercise session loss during a write.

Fact correction currently uses a document and unit from the displayed observations. With no observed source, or for a rent schedule, correction is disabled just as unsupported correction input must be refused. The existing source record remains available for wider term entry. Production persistence, signed-in authority and email delivery remain unverified locally.
