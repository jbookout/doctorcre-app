# Client portal

The authenticated app portal reads the canonical transaction roadmap and explicitly shared text through `client-portal.v1`. Public client-site hosting is a separate slice.

## Sub-features

`portal-password`, `portal-roadmap`, `portal-shared-text`, `portal-lock`.

## How to get to it (user POV)

Open `/client-portal` directly. In the local synthetic preview, enter portal name `demo-practice` and password `demo-portal`. Choose Open portal. Review the roadmap, its Current step marker and the shared document, tour and report. Choose Lock portal to clear the material and return to password entry.

## Driving it with Playwright

Existing coverage is `test/client-portal.test.mjs`, `test/client-portal-browser.test.mjs` and the portal gate case in `test/worker.test.mjs`.

- Open the direct route at 390px and 1440px. Require all eight synthetic phases, Negotiation marked Current step, three shared text entries and no horizontal overflow.
- Require an empty password field after submission. Lock the portal and require the content area empty. Reopen, then retire the page and require the same clearing behavior.
- The synthetic HTTP case drives the live transport through same-origin session and MCP fixtures. Require only `read-client-portal` with slug and password, literal HTML-like text, no internal note and no password in the URL or browser storage.
- Attempt another portal and require a refusal with no previous material. Lock a held read and require its late result to stay hidden.
- Captures are written under `out/test-artifacts/client-portal`. Inspect them before claiming visual proof.

## Gotchas

The app PR must wait for server PR #2291 to be live. These tests do not prove deployed portal sessions, client-site migration, existing client passwords, public throttling or binary-artifact access. Local fixture mode never contacts CARR. Explain the absent material state rather than presenting a fabricated artifact or internal note. Passwords and responses must never enter Doc context, URLs, diagnostics or browser storage.
