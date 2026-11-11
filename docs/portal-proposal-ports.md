# Tour List proposal ports

Card: WR586.S5.J16

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

## Remaining integration

This is a partial source prerequisite. The pinned producer contract explicitly has no public HTTP route. Its authenticated SQL connection is forbidden to the app. No HTTP path, credential or response envelope has been invented. The public host must supply these read/save functions after its transport contract is published and deployed. This branch does not implement or attest server-side CSRF, origin, rate limits or connection deadlines. It does not alter legacy URLs, passwords or hosting.

A signed-in staging journey, independent taste score and production proof remain required. The component browser tests use the producer recording and contract-checked synthetic replies through the production parser; they do not prove live transport or remote persistence. No runnable production proof CLI exists for this transport yet. The future proof must read a containing `/app-release`, compare the exact displayed IDs/version/notes with an independent authorized proposal read, navigate away and back, and inspect an existing authorized save receipt. It must not create synthetic production choices. Exit 78 means the release or authorized evidence is unavailable.

## Design and debt pass

Codebase-design keeps receipt validation behind one adapter and controller lifetime at the publication host. The route-owned alternative was rejected. Zero-tech-debt reuses the existing control implementation and removes three frozen legacy TypeScript exclusions so these changed files join the strict generated projects. Biome formatting and inherited accessibility corrections account for most line growth. No runtime change belongs in software-factory, and no CARR source changes are included.
