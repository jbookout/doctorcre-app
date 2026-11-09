# Exact action cards

Direct action links read their canonical sources without searching Home. Lead drafts retain v1. Reply drafts, post-call reviews and feedback events use `resolve-action-link-v2`.

The contract and five recorded synthetic responses are pinned to CARR merge `44a493c74a570aa812f8d6c687d2974335a4061c`. The contract SHA-256 is `5234aa7b6a163edf50df0435e0a12bf7c44d6106dee76c0f4de2ba3cfc132c8b`. The responses passed the exact production parser function extracted from that revision, then the app parser and browser path.

| Transition | Behavior test |
|---|---|
| Opening to current or resolved card | `cold navigation and existing tab show all three exact cards without inbox reads at phone and desktop sizes` |
| Opening to stale or retired source | `lifecycle cards retain exact identity and suppress unavailable operations` |
| Opening to unavailable or signed out | `wrong partner malformed near-match offline and expired session disclose no card; sign-in preserves reference` |
| Current card to signed out | Same browser test invalidates the session after rendering. |
| Signed out to same reference | Same test restores authentication and follows the preserved reference. |
| Unavailable to loading | `reply transport reload is manual and fresh resolve replaces prior data` |
| Current review to reloading | `post-call completion rechecks the displayed version before the domain operation` |
| Reply approval to confirmed or unknown | Existing action-link tests bind recipients, version and idempotency key. |

The model separates session privacy and visible card state. It abstracts network timing, server transactions and the existing reply approval machine. It does not prove server authorization or transactional concurrency. Post-call completion takes only the existing session ID argument. The app re-resolves the displayed version before invoking it. Feedback has no mutation.

## PRODUCTION PROOF

`scripts/prove-exact-action-cards.ts` accepts `--origin`, `--commit`, `--reply-ref`, `--reply-id`, `--call-ref`, `--call-id`, `--feedback-ref`, `--feedback-id`, `--foreign-ref` and `--cdp-url`. Populate these from existing authorized records after a containing app release. It borrows an authenticated loopback CDP session, opens all three references in one tab, compares independently resolved IDs exactly, refuses a foreign reference and checks stable release identity. No mutation is invoked.

Exit 0 means a containing release passed all assertions. Exit 1 means an assertion failed. Exit 78 means insufficient evidence, including an unavailable registered read or session. `node --test test/exact-action-cards.browser.ts` runs executable CLI fixtures for all three exits.

Regenerate in a scratch directory with `statechart.mjs from-chart ExactCards.mmd --png`, using Java and tla2tools.jar. Browser tests and the abstract model do not constitute live production proof before deployment.
