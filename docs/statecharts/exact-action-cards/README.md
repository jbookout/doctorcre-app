# Exact action cards

Direct action links read their canonical sources without searching Home. Lead drafts retain v1. Reply drafts, post-call reviews and feedback events use `resolve-action-link-v2`.

Depends on carr 3091. Contracts are copied byte-for-byte through the existing `contracts/carr-interface.v1/` mechanism from CARR `e54fdcbee30d557c18d262611a40a0e49a89b5dd`. Resolver SHA-256 is `a9eb245d40445044ef60bf318e6b148b37206b41118cf57b7b99eb12066ef113`; review-call-outcome.v1 SHA-256 is `16fd6959de22e9c15d20b3c23ecfd7fec0f08aaca10c3fa636d8e25a99f53ab7`. The browser validates command, success, replay and public refusal fixtures against these producer contracts, then consumes their MCP envelopes through the production transport parser.

Every arrow is exercised through a mounted browser view. The initial arrows are covered by cold navigation. Session arrows and card arrows share their user trigger in the two independent regions.

| Arrow | Browser behavior test |
|---|---|
| Session initial to SignedIn; Card initial to Opening; root initial to App | `cold navigation and existing tab show all three exact cards without inbox reads at phone and desktop sizes` |
| SignedIn to SignedOut on session refusal | `mounted pending_review card clears on session refusal` and the expired-session sign-in test |
| SignedOut to SignedIn on sign in to same reference | `wrong partner malformed near-match offline and expired session disclose no card; sign-in preserves reference` follows the actual login link through a synthetic login redirect |
| SignedIn to SignedIn on authorized current source | Cold-navigation test opens the pending post-call card |
| SignedIn to SignedIn on source resolved | Cold-navigation test opens feedback |
| SignedIn to SignedIn on source changed | `mounted stale card clears on session refusal` first renders stale |
| SignedIn to SignedIn on source retired | `mounted retired card clears on session refusal` first renders retired |
| Opening to Review on authorized current source | Cold-navigation test and `mounted pending_review card clears on session refusal` |
| Opening to Resolved on source resolved | Cold-navigation test and `mounted resolved card clears on session refusal` |
| Opening to Stale on source changed | `mounted stale card clears on session refusal` asserts the stale message and absent mutation |
| Opening to Retired on source retired | `mounted retired card clears on session refusal` asserts the retired message and absent mutation |
| Opening to Unavailable on invalid, foreign reference or network failure | Wrong-partner/malformed/near-match/offline browser test |
| Opening to Unavailable on session refused | Expired-session sign-in browser test |
| Review to Unavailable on session refused | `mounted pending_review card clears on session refusal` |
| Resolved to Unavailable on session refused | `mounted resolved card clears on session refusal` |
| Stale to Unavailable on session refused | `mounted stale card clears on session refusal` |
| Retired to Unavailable on session refused | `mounted retired card clears on session refusal` |
| Unavailable to Unavailable on session refused | `mounted unavailable card clears on session refusal` |
| Unavailable to Opening on user reloads | `reply transport reload is manual and fresh resolve replaces prior data` in action-link-browser |
| Unavailable to Opening on sign in to same reference | Sign-in browser test follows the login link and returns to the exact card |
| Review to Review on unconfirmed receipt retains retry intent | `post-call review refuses unconfirmed receipt` reloads and retries with the same key, including matching success fields plus an error |
| Review to Opening on matching review receipt | `post-call review uses registered input and receipt and retains its intent key after a lost response and reload` |

| Review to Stale on write refuses changed source | `atomic review refuses an edit between display and write and reopens current version` |
| Stale to Opening on open current version | The same atomic-refusal browser test resolves the latest version, follows its reference and renders the new review |

The model abstracts network timing, server transactions and the existing reply approval machine. It does not prove database concurrency. CARR owns the atomic version guard; the app sends the displayed version in the write without a preflight read. Feedback has no mutation. The atomic-refusal fixture models a canonical candidate edit after display and before the write. The producer refusal passes its pinned refusal schema and the production MCP parser before the UI enters stale. Matching-version receipt and replay follow the pinned response schema. The existing invalid-receipt cases intentionally violate it and remain unconfirmed.

Review intent is immutable. `reviewCallOutcome` verifies the principal and derives a UUID from a namespaced SHA-256 of principal, call ID and displayed source version. It owns command identity; neither component receipts nor session cleanup can rotate it. Nothing is persisted. Success ends command eligibility; stale source requires reopening; 401/403 and sign-out erase private state and retire the document. An authorized reopen of the same principal/source reconstructs the same identity, and another principal or source reconstructs a different identity. Shared Home callers remain unchanged.

`ReviewIntent.mmd` adds one intent region alongside session access. `ReviewIntent-model` contains the compiled model. It abstracts the hash and transaction; executable command/browser tests establish key equality and the producer contract establishes atomic source guarding. No unbounded retention claim is made about the producer replay window.

| Intent transition | Executed behavior test |
| --- | --- |
| Eligible to Sending | atomic review accepts matching displayed version |
| Unconfirmed to Sending | post-call review refuses unconfirmed receipt |
| Sending to Unconfirmed | post-call review uses registered input and receipt and retains its intent key after a lost response and reload |
| Unconfirmed to Eligible | same lost-response/reload test |
| Sending to Confirmed | same lost-response/replay test and atomic matching-version test |
| Sending to Changed | atomic review refuses an edit between display and write and reopens current version |
| Changed to Eligible | same changed-source/reopen test |
| Eligible to Retired | mounted pending_review card clears on session refusal |
| Sending to Retired | review intent survives HTTP 401/403 retirement without retaining private storage |
| Unconfirmed to Retired | sign out erases private state and reopening under another principal derives a distinct review |
| Confirmed to Retired | mounted resolved card clears on session refusal |
| Changed to Retired | mounted stale card clears on session refusal |
| Retired to Eligible | HTTP 401/403 retirement tests and sign-out/another-principal test |
| Access Authorized to SignedOut | same retirement tests |
| Access SignedOut to Authorized | same reopen tests |

## PRODUCTION PROOF

`scripts/prove-exact-action-cards.ts` accepts `--origin`, `--commit`, `--reply-ref`, `--reply-id`, `--call-ref`, `--call-id`, `--feedback-ref`, `--feedback-id`, `--foreign-ref` and `--cdp-url`. Populate these from existing authorized records after a containing app release. It borrows an authenticated loopback CDP session, opens all three references in one tab, compares independently resolved IDs exactly, refuses a foreign reference and checks stable release identity. No mutation is invoked.

Exit 0 means a containing release passed all assertions. Exit 1 means an assertion failed. Exit 78 means insufficient evidence, including an unavailable registered read or session. `node --test test/exact-action-cards.browser.ts` runs executable CLI fixtures for all three exits.

Regenerate in a scratch directory with `statechart.mjs from-chart ExactCards.mmd --png`, using Java and tla2tools.jar. Browser tests and the abstract model do not constitute live production proof before deployment.

Producer pin for this redesign: DoctorCRE/carr-system e54fdcbee30d557c18d262611a40a0e49a89b5dd (PR 3091). Review contract SHA-256 `16fd6959de22e9c15d20b3c23ecfd7fec0f08aaca10c3fa636d8e25a99f53ab7`. Producer must deploy before this consumer; repin to its merged revision before consumer merge.
