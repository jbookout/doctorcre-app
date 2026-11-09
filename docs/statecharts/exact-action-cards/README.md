# Exact action cards

Direct action links read their canonical sources without searching Home. Lead drafts retain v1. Reply drafts, post-call reviews and feedback events use `resolve-action-link-v2`.

The contract and five recorded synthetic responses are pinned to CARR merge `44a493c74a570aa812f8d6c687d2974335a4061c`. The contract SHA-256 is `5234aa7b6a163edf50df0435e0a12bf7c44d6106dee76c0f4de2ba3cfc132c8b`. The responses passed the exact production parser function extracted from that revision, then the app parser and browser path.

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
| Review to Opening on user marks reviewed after version check | `post-call review uses registered input and receipt and retains its intent key after a lost response and reload` |

The model abstracts network timing, server transactions and the existing reply approval machine. It does not prove transactional concurrency. The existing preflight read is a separate request and is **not version enforcement**. The transactional producer change is tracked in WR617.S1.J184; until it is pinned, concurrent edits remain an open review finding. Feedback has no mutation.

The registered write input fixture is extracted from `mcp-server/src/tools.js` at the same pinned CARR revision. The browser validates every completion command against that input, uses the handler's `{ok:true, session_id, reviewed:true}` receipt, and tests missing identity, wrong identity and error receipts. Pending review intent keys persist in session storage across manual reload and lost responses; only a matching success receipt clears the key. The fixture with nonempty candidates passed the exact parser function extracted from `mcp-server/src/action-card-targets.ts` at that revision.

## PRODUCTION PROOF

`scripts/prove-exact-action-cards.ts` accepts `--origin`, `--commit`, `--reply-ref`, `--reply-id`, `--call-ref`, `--call-id`, `--feedback-ref`, `--feedback-id`, `--foreign-ref` and `--cdp-url`. Populate these from existing authorized records after a containing app release. It borrows an authenticated loopback CDP session, opens all three references in one tab, compares independently resolved IDs exactly, refuses a foreign reference and checks stable release identity. No mutation is invoked.

Exit 0 means a containing release passed all assertions. Exit 1 means an assertion failed. Exit 78 means insufficient evidence, including an unavailable registered read or session. `node --test test/exact-action-cards.browser.ts` runs executable CLI fixtures for all three exits.

Regenerate in a scratch directory with `statechart.mjs from-chart ExactCards.mmd --png`, using Java and tla2tools.jar. Browser tests and the abstract model do not constitute live production proof before deployment.
