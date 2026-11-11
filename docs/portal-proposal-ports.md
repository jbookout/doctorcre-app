# Tour List proposal ports

Card: WR586.S5.J19

The package host accepts `proposals` containing the authenticated host's publication ID and revision, receipt-producing read/save functions, and existing sign-out and retirement callbacks. It registers Tour List alongside existing package panels. The controller belongs to the mounted publication, survives fragment navigation, and disposes before another publication mounts in the same element.

The app pins portal-proposals.v1 1.0.0 and its real SQL recording from DoctorCRE/carr-system commit 1809cc7e3c52eb649707e6ac664dfb33dc5a60e1. `contracts/portal-proposals.provenance.json` records the source and SHA-256 of each copied file. The parser refuses unknown statuses, cross-publication receipts, stale source revisions, malformed notes and unknown IDs. It never trims or substitutes property IDs. Retired identities and notes stay visible until explicitly removed. Retired identities cannot be added back or submitted as current candidates.

## System design

The CARR producer owns authorization, private proposal persistence, canonical property membership and CAS. The app owns receipt parsing, transient drafts and presentation. Boundary Discipline puts the versioned receipt checks in `proposal-ports.ts`. Make Operations Idempotent preserves the controller's frozen request and the host's exact source revision on uncertain retries. Model the Domain retains the existing controller state machine and adds explicit retired-entry metadata.

Two designs were considered. A route-owned controller would reread and lose drafts on navigation. A publication-owned controller plus a narrow receipt adapter keeps the existing controls and routing. The second design is implemented. No database, background queue, polling, persistent cache, fan-out or automatic retry exists. One read and one single-flight save cover the whole list. Work and memory are linear in property count, including at tenfold load; rendered cards break first. One failed operation requires an explicit user retry. Deadlines and abort handling remain in the existing controller. Server-side authentication, CSRF, origin, rate and connection limits must remain in the public host.

The throughput checkpoint was contract inspection first, one coupled parser/controller/host workstream, no shared writers, and sequential verification. Subagents were forbidden. The original statechart was reused before implementation; route and host variables were added and checked after the first implementation, rather than before it.

## Statechart coverage

The retained model is `test/models/portal-tour-list/TourList.tla`. It abstracts transport receipts and tracks screen phase, private state, frozen-request presence, route and host generation. It does not model SQL, HTTP policy or property payloads.

| Transition | Behavior test |
| --- | --- |
| Read, load failure and retry | `load failure retries, invalid IDs refuse and 401 expires` |
| Edit, Save, Receipt, Retry, Reload | `transport uncertainty retries frozen request and exact source revision; conflicts lock edits` |
| Logout and LogoutFailure | `sign out clears memory, retries endpoint with same key, gates only after revocation` |
| Retire | Existing phase-to-expire and phase-to-dispose parameterized tests |
| RouteSwitch and HostSwitch | `proposal host route lifetime, transport, keyboard and retirement` at each width/theme |
| Retired entry removal | `retired entries preserve original IDs and notes and require explicit removal before saving` |
| Stay | Existing single-flight test rejects a second pending save |

## HTTP transport

The host accepts either an injected `transport` or an explicit `slug` alongside its publication scope and existing lifecycle callbacks. A slug constructs `proposalHttpTransport` behind the existing receipt parser. It uses the origin-form routes from CARR PR 3206 at c2d5de0db4af858e41d692c7f736b98d5200e233, `mcp-server/src/portal-web.ts`.

Read uses GET `/<slug>/proposals/<publication UUID>`. Save first reads GET `/<slug>/status` for `{authenticated:true,csrf:string}`, then POSTs to the proposal route with `X-Portal-CSRF`, JSON content type and exactly `{publication_version,request:{version,selected,notes,idempotency_key}}`. Every fetch uses same-origin mode and credentials, no-store, and refuses redirects. No base URL or credential is configured or persisted. A single ten-second abort deadline covers status, transport and response parsing. Disposal cancels the same work. Explicit retry refreshes CSRF but retains the exact publication revision and frozen proposal. There is no automatic retry, cache, queue or fan-out. Server admission, shared rate limits and circuit breakers remain CARR's authority.

Known status/code pairs map through existing controller transitions. Unauthenticated expires the session and clears private state. Stale version and retired map to conflict. CSRF, origin, rate limit, unknown error codes and unavailable saves map to uncertain and keep the frozen request. Unknown 409 codes never become discardable conflicts. Read failures map to unavailable, except unauthenticated which expires. No new controller transition was added. TLC was rerun against the retained model.

`portal-proposal-http.test.ts` checks each refusal and frozen retry, exact JSON keys and transport options, status/save/body deadline and cancellation. `portal-proposal-http.browser.ts` loads current-source assets through `appAssetSnapshot()` and `startWorkerFixture()`, mounts the host with a slug, then saves, retries an unknown outcome and reloads exact membership and notes in both themes at 390 and 1440. HTTP replies use the pinned producer receipt through the production parser. These synthetic browser replies do not attest server authentication or SQL persistence.

## Remaining deployment evidence

This draft depends on CARR PR 3206 deploying with the portal host mounted on its configured same origin and serving the app shell. It does not alter legacy URLs, passwords or hosting. Signed-in staging, independent taste and production persistence remain unverified. A runnable production proof CLI remains absent. A future read-only proof must compare exact displayed IDs, version and notes with an authorized independent read and require containing app and CARR releases. The worker was forbidden production calls and subagents.

## Design and debt pass

Codebase-design keeps receipt validation behind one adapter and controller lifetime at the publication host. The route-owned alternative was rejected. Zero-tech-debt reuses the existing control implementation and removes three frozen legacy TypeScript exclusions so these changed files join the strict generated projects. Biome formatting and inherited accessibility corrections account for most line growth. No runtime change belongs in software-factory, and no CARR source changes are included.
